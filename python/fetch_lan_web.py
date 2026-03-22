"""
Vyčtení dat z webového rozhraní v LAN přes Playwright (přihlášení + extrakce).

Výchozí režim A-ZROUTER: po přihlášení navigace na #/devices (teplota vody, aktivní stav),
volitelně druhá stránka (např. přehled) pro doplnění teploty z hlavičky.

Výstup: jeden řádek JSON na stdout (stejně jako fetch_runtime.py).

Povinné proměnné prostředí:
  LAN_WEB_USER, LAN_WEB_PASSWORD

Volitelné:
  LAN_WEB_BASE_URL
  LAN_WEB_LOGIN_PATH       — výchozí #/login
  LAN_WEB_DATA_PATH        — první stránka s daty (výchozí #/devices)
  LAN_WEB_ALT_PATH         — druhá stránka (např. #/ pro přehled) — doplní jen chybějící pole
  LAN_WEB_HEADLESS, LAN_WEB_TIMEOUT_MS, LAN_WEB_POST_LOGIN_WAIT_MS
  LAN_WEB_PAGE_SETTLE_MS   — pauza po načtení stránky (výchozí 2500)
  LAN_WEB_EXTRACT_JS       — vlastní () => ({ ... }) — přepíše vestavěnou extrakci
  LAN_WEB_EXTRACT_MODE=raw — pouze zkrácený text stránky (ladění)

Instalace:
  py -m pip install playwright
  py -m playwright install chromium
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "Chybí playwright. Nainstalujte: py -m pip install playwright && py -m playwright install chromium",
                "ts": datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
        )
    )
    sys.exit(1)


def _truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


def _login_url(base: str, login_path: str) -> str:
    base = base.rstrip("/")
    path = (login_path or "#/login").strip()
    if not path.startswith("#"):
        path = "#/" + path.lstrip("/")
    return f"{base}{path}" if path.startswith("#") else f"{base}/{path}"


def _hash_url(base: str, hash_path: str) -> str:
    base = base.rstrip("/")
    path = (hash_path or "#/devices").strip()
    if not path.startswith("#"):
        path = "#/" + path.lstrip("/")
    return f"{base}{path}"


def _fill_credentials(page, user: str, password: str) -> None:
    user_sel = os.environ.get("LAN_WEB_USER_SELECTOR", "").strip()
    pass_sel = os.environ.get("LAN_WEB_PASSWORD_SELECTOR", "").strip()

    if user_sel:
        page.locator(user_sel).first.fill(user, timeout=15000)
    else:
        u = page.locator('input[type="text"], input[type="email"]').first
        try:
            u.wait_for(state="visible", timeout=5000)
        except Exception:
            u = page.locator('input:not([type="password"])').first
            u.wait_for(state="visible", timeout=15000)
        u.fill(user)

    if pass_sel:
        page.locator(pass_sel).first.fill(password, timeout=15000)
    else:
        p = page.locator('input[type="password"]').first
        p.wait_for(state="visible", timeout=15000)
        p.fill(password)


def _click_login(page) -> None:
    btn_sel = os.environ.get("LAN_WEB_LOGIN_BUTTON_SELECTOR", "").strip()
    if btn_sel:
        page.locator(btn_sel).first.click(timeout=15000)
        return
    try:
        loc = page.get_by_role("button", name=re.compile(r"login|přihl|sign\s*in", re.I))
        if loc.count() > 0:
            loc.first.click(timeout=5000)
            return
    except Exception:
        pass
    sub = page.locator('button[type="submit"], input[type="submit"]')
    if sub.count() > 0:
        sub.first.click(timeout=15000)
        return
    page.locator("button").filter(has_text=re.compile(r"login|přihl", re.I)).first.click(timeout=15000)


def _wait_after_login(page) -> None:
    ms = int(os.environ.get("LAN_WEB_POST_LOGIN_WAIT_MS", "45000"))
    strict = _truthy("LAN_WEB_LOGIN_HASH_STRICT", "1")

    def left_login() -> bool:
        h = (page.evaluate("() => location.hash || ''") or "").lower()
        return "login" not in h

    try:
        page.wait_for_function(
            "() => { const h = (location.hash || '').toLowerCase(); return !h.includes('login'); }",
            timeout=ms,
        )
    except Exception:
        if strict:
            if not left_login():
                raise RuntimeError(
                    "Po přihlášení zůstala hash #/login — zkontrolujte údaje nebo LAN_WEB_LOGIN_HASH_STRICT=0."
                )
        try:
            page.wait_for_load_state("networkidle", timeout=min(ms, 15000))
        except Exception:
            pass


def _goto_hash(page, base: str, hash_path: str, timeout_ms: int) -> None:
    url = _hash_url(base, hash_path)
    page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    try:
        page.wait_for_load_state("networkidle", timeout=12000)
    except Exception:
        pass


def _read_azrouter_js() -> str:
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extract_azrouter.js")
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def _merge_lan_data(merged: dict, part: dict) -> dict:
    """Druhá stránka doplňuje jen klíče, které chybějí nebo jsou None (nepřepisuje už nastavené)."""
    out = {**merged}
    for k, v in part.items():
        if v is None:
            continue
        if k not in out or out[k] is None:
            out[k] = v
    return out


def _path_key(p: str) -> tuple[int, str]:
    """Přehled #/ před #/devices — lepší sloučení teploty a „Active“."""
    s = (p or "").strip().lower()
    if s in ("#/", "#/home", "#/dashboard", "#/index"):
        return (0, p)
    if "device" in s:
        return (2, p)
    return (1, p)


def _consolidate_azrouter_parts(parts: list[dict]) -> dict:
    """Sloučí výstupy z více hash stránek: zlomek z karty zařízení má prioritu, aktivní = OR."""
    if not parts:
        return {}
    merged: dict = {}
    for part in parts:
        if isinstance(part, dict):
            merged = _merge_lan_data(merged, part)
    for part in reversed(parts):
        if not isinstance(part, dict):
            continue
        t = part.get("boiler_target_temp_c")
        if t is not None and not (isinstance(t, float) and (t != t)):  # not NaN
            merged["boiler_water_temp_c"] = part.get("boiler_water_temp_c")
            merged["boiler_target_temp_c"] = part.get("boiler_target_temp_c")
            break
    if merged.get("boiler_water_temp_c") is None:
        for part in parts:
            if not isinstance(part, dict):
                continue
            w = part.get("boiler_water_temp_c")
            if w is not None:
                merged["boiler_water_temp_c"] = w
                break
    if any(isinstance(p, dict) and p.get("boiler_status_active") is True for p in parts):
        merged["boiler_status_active"] = True
    elif any(isinstance(p, dict) and p.get("boiler_status_active") is False for p in parts):
        merged["boiler_status_active"] = False
    return merged


def _extract(page) -> dict:
    js_custom = os.environ.get("LAN_WEB_EXTRACT_JS", "").strip()
    if js_custom:
        wrapped = f"() => {{ const fn = {js_custom}; return typeof fn === 'function' ? fn() : fn; }}"
        try:
            return page.evaluate(wrapped)
        except Exception as e:
            return {"extract_error": str(e)}

    mode = os.environ.get("LAN_WEB_EXTRACT_MODE", "azrouter").strip().lower()
    if mode == "raw":
        text = page.evaluate(
            """() => {
          const t = document.body && document.body.innerText ? document.body.innerText : '';
          return t.replace(/\\s+/g, ' ').trim().slice(0, 4000);
        }"""
        )
        return {"page_text": text}

    try:
        az_js = _read_azrouter_js()
        return page.evaluate(az_js)
    except Exception as e:
        return {"extract_error": str(e), "source": "azrouter"}


def run() -> dict:
    base = (os.environ.get("LAN_WEB_BASE_URL") or "").strip()
    user = (os.environ.get("LAN_WEB_USER") or "").strip()
    password = (os.environ.get("LAN_WEB_PASSWORD") or "").strip()
    login_path = (os.environ.get("LAN_WEB_LOGIN_PATH") or "#/login").strip()

    if not base:
        return {"ok": False, "error": "Chybí LAN_WEB_BASE_URL."}
    if not user or not password:
        return {"ok": False, "error": "Chybí LAN_WEB_USER nebo LAN_WEB_PASSWORD (nastavte v .env)."}

    timeout_ms = int(os.environ.get("LAN_WEB_TIMEOUT_MS", "60000"))
    headless = _truthy("LAN_WEB_HEADLESS", "1")
    primary_data_path = (os.environ.get("LAN_WEB_DATA_PATH") or "#/devices").strip()
    alt_path = (os.environ.get("LAN_WEB_ALT_PATH") or "").strip()
    settle_ms = int(os.environ.get("LAN_WEB_PAGE_SETTLE_MS", "3200"))
    use_custom_js = bool((os.environ.get("LAN_WEB_EXTRACT_JS") or "").strip())
    auto_dash = _truthy("LAN_WEB_AUTO_ALT_DASHBOARD", "1")

    raw_paths: list[str] = [primary_data_path]
    if not use_custom_js:
        ap = alt_path
        if ap and ap not in raw_paths:
            raw_paths.append(ap)
        elif auto_dash:
            dash = "#/"
            if dash not in [x.strip() for x in raw_paths] and primary_data_path.strip() != dash:
                raw_paths.append(dash)

    paths = sorted(set(raw_paths), key=_path_key)

    url = _login_url(base, login_path)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        try:
            context = browser.new_context(ignore_https_errors=True)
            page = context.new_page()
            page.set_default_timeout(timeout_ms)
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            _fill_credentials(page, user, password)
            _click_login(page)
            _wait_after_login(page)
            extra_wait = int(os.environ.get("LAN_WEB_EXTRA_WAIT_MS", "1800"))
            if extra_wait > 0:
                page.wait_for_timeout(extra_wait)

            parts_list: list[dict] = []
            for hp in paths:
                _goto_hash(page, base, hp, timeout_ms)
                if settle_ms > 0:
                    page.wait_for_timeout(settle_ms)
                try:
                    page.wait_for_function(
                        "() => (document.body && document.body.innerText && document.body.innerText.length > 80)",
                        timeout=12000,
                    )
                except Exception:
                    pass
                part = _extract(page)
                parts_list.append(part if isinstance(part, dict) else {})
                if use_custom_js:
                    break

            data = _consolidate_azrouter_parts(parts_list) if not use_custom_js else (parts_list[0] if parts_list else {})
            final_url = page.url
            title = page.title()
        finally:
            browser.close()

    return {
        "ok": True,
        "ts": datetime.now(timezone.utc).isoformat(),
        "source": "lan_web",
        "url_after": final_url,
        "title": title,
        "data": data,
    }


def main() -> None:
    try:
        payload = run()
        print(json.dumps(payload, ensure_ascii=False))
        if not payload.get("ok"):
            sys.exit(1)
    except Exception as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(e),
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "source": "lan_web",
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
