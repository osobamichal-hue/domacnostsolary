/**
 * Základní URL Node API (GoodWe HomeAPP).
 * Při servování statických souborů z Apache (např. /HomeAPP/public/) musí být API na jiném
 * originu (typicky http://localhost:3000) — relativní /api/... by jinak šlo na Apache (HTML 404).
 *
 * Priorita:
 * 1) window.HOMEAPP_API_BASE (např. nastavit v <script> před načtením tohoto souboru)
 * 2) <meta name="homeapp-api-base" content="http://127.0.0.1:3000">
 * 3) Heuristika: cesta obsahuje /HomeAPP/ a port je 80/443 → http(s)://host:3000
 */
(function () {
  /**
   * Pokud je uložená API adresa jen jiným zápisem stejného serveru (např. 127.0.0.1 vs localhost),
   * použij relativní cesty — jinak fetch/cookies mezi originy selžou.
   */
  function normalizeStoredApiBase(raw) {
    if (typeof window === "undefined" || !raw) return "";
    try {
      const b = String(raw).trim().replace(/\/$/, "");
      if (!b) return "";
      const bu = new URL(b);
      const loc = window.location;
      if (bu.origin === loc.origin) return "";
      const loop = (h) => h === "localhost" || h === "127.0.0.1";
      if (bu.protocol === loc.protocol && loop(bu.hostname) && loop(loc.hostname)) {
        const bp = bu.port || (bu.protocol === "https:" ? "443" : "80");
        const lp = loc.port || (loc.protocol === "https:" ? "443" : "80");
        if (String(bp) === String(lp)) return "";
      }
      return b;
    } catch {
      return String(raw).trim().replace(/\/$/, "");
    }
  }

  function inferBase() {
    if (typeof window === "undefined") return "";
    const w = window;
    if (w.HOMEAPP_API_BASE != null && String(w.HOMEAPP_API_BASE).trim() !== "") {
      const nb = normalizeStoredApiBase(w.HOMEAPP_API_BASE);
      return nb === "" ? "" : nb;
    }
    try {
      const ls = localStorage.getItem("homeapp_api_base");
      if (ls != null && String(ls).trim() !== "") {
        const n = normalizeStoredApiBase(ls);
        if (n === "") return "";
        return n;
      }
    } catch {
      /* ignore */
    }
    const meta =
      typeof document !== "undefined" &&
      document.querySelector &&
      document.querySelector('meta[name="homeapp-api-base"]');
    const c = meta && meta.getAttribute("content");
    if (c != null && String(c).trim() !== "") {
      return normalizeStoredApiBase(c);
    }
    if (typeof window.location === "undefined") return "";
    const { protocol, hostname, port, pathname } = window.location;
    const p = String(port || "");
    const pubAppHtml = /\/public\/(stats|index|settings|login)\.html$/i.test(pathname);
    const isApacheSubfolder =
      (p === "" || p === "80" || p === "443") &&
      (/\/homeapp\b/i.test(pathname) || pubAppHtml);
    if (isApacheSubfolder) {
      return `${protocol}//${hostname}:3000`;
    }
    return "";
  }

  window.__homeappApiBase = inferBase();

  window.apiUrl = function apiUrl(path) {
    const p = path.startsWith("/") ? path : `/${path}`;
    const b = window.__homeappApiBase || "";
    return b ? `${b}${p}` : p;
  };

  /** WebSocket origin (ws://host nebo wss://host) — stejný host jako API při přesměrování. */
  window.apiWsUrl = function apiWsUrl() {
    const b = window.__homeappApiBase;
    if (b) {
      try {
        const u = new URL(b);
        return (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host;
      } catch {
        /* fall through */
      }
    }
    if (typeof window.location !== "undefined") {
      return (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host;
    }
    return "ws://127.0.0.1:3000";
  };

  window.apiFetch = function apiFetch(path, init) {
    const url = window.apiUrl(path);
    let cross = false;
    try {
      if (typeof window !== "undefined" && window.location && url.startsWith("http")) {
        cross = new URL(url).origin !== window.location.origin;
      }
    } catch {
      cross = false;
    }
    const merged = {
      credentials: cross ? "include" : "same-origin",
      ...init,
    };
    return fetch(url, merged);
  };
})();
