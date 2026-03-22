/* global apiFetch, apiUrl */
(function ensureApiHelpers() {
  if (typeof window.apiFetch === "function") return;
  window.apiUrl = function (path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    return p;
  };
  window.apiFetch = function (path, init) {
    return fetch(window.apiUrl(path), { credentials: "same-origin", ...init });
  };
})();

const $ = (id) => document.getElementById(id);

function setStatus(text, ok = false) {
  const el = $("formStatus");
  el.textContent = text || "";
  el.classList.toggle("form-status--ok", !!ok);
  el.classList.toggle("form-status--err", !ok && !!text);
}

async function submitAuth(ev) {
  ev.preventDefault();
  setStatus("");
  const username = String($("username").value || "").trim();
  const password = String($("password").value || "");

  if (!username || !password) {
    setStatus("Vyplňte uživatelské jméno i heslo.");
    return;
  }

  try {
    const r = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      setStatus(
        `Server nevrátil JSON (HTTP ${r.status}). ${String(text).trim().slice(0, 120)}`
      );
      return;
    }
    if (!r.ok || j.ok === false) {
      setStatus(j.error || "Operace se nezdařila.");
      return;
    }
    setStatus("Přihlášení proběhlo.", true);
    const base = window.__homeappApiBase;
    window.location.href = base ? `${String(base).replace(/\/$/, "")}/` : "/";
  } catch (e) {
    setStatus(
      `Nelze kontaktovat API (${e && e.message ? e.message : "síť"}). Je spuštěný Node server (npm start)?`
    );
  }
}

$("authForm").addEventListener("submit", submitAuth);
