/* global apiFetch */
const $ = (id) => document.getElementById(id);
const THEME_KEY = "homeapp_theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "🌞" : "🌙";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (prefersLight ? "light" : "dark"));
  $("themeToggle")?.addEventListener("click", () => {
    const curr = document.documentElement.getAttribute("data-theme") || "dark";
    const next = curr === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function initLogout() {
  $("logoutBtn")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    window.location.href = "/login.html";
  });
}

async function parseApiResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.ok) {
      throw new Error("Server vrátil neplatnou odpověď.");
    }
    const shortText = String(text || "").trim().slice(0, 180);
    throw new Error(shortText || `HTTP ${res.status}`);
  }
}

function showStatus(el, text, ok) {
  el.textContent = text;
  el.classList.remove("form-status--ok", "form-status--err");
  if (ok === true) el.classList.add("form-status--ok");
  if (ok === false) el.classList.add("form-status--err");
}

async function loadConfig() {
  const r = await apiFetch("/api/config");
  const j = await parseApiResponse(r);
  if (!j.ok) throw new Error(j.error || "Nelze načíst konfiguraci");
  $("goodweHost").value = j.goodweHost || "";
  $("pollIntervalSec").value = String(Math.round((j.pollIntervalMs || 10000) / 1000));
  $("feedInCzkPerKwh").value = String(j.feedInCzkPerKwh ?? j.feedInEurPerKwh ?? 5.5);
  $("pythonExe").value = j.pythonExe || "python";
  $("lanWebEnabled").checked = Boolean(j.lanWebEnabled);
  $("lanWebBaseUrl").value = j.lanWebBaseUrl || "";
  $("lanWebLoginPath").value = j.lanWebLoginPath || "#/login";
  $("lanWebDataPath").value = j.lanWebDataPath || "#/devices";
  $("lanWebAltPath").value = j.lanWebAltPath || "";
}

$("cfgForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("formStatus");
  const btn = $("btnSave");
  showStatus(status, "Ukládám…", undefined);
  btn.disabled = true;

  const pollSec = Number($("pollIntervalSec").value);
  const body = {
    goodweHost: $("goodweHost").value.trim(),
    pollIntervalMs: Math.round(pollSec * 1000),
    feedInCzkPerKwh: Number($("feedInCzkPerKwh").value),
    pythonExe: $("pythonExe").value.trim(),
    lanWebEnabled: $("lanWebEnabled").checked,
    lanWebBaseUrl: $("lanWebBaseUrl").value.trim(),
    lanWebLoginPath: $("lanWebLoginPath").value.trim() || "#/login",
    lanWebDataPath: $("lanWebDataPath").value.trim() || "#/devices",
    lanWebAltPath: $("lanWebAltPath").value.trim(),
  };

  try {
    const r = await apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await parseApiResponse(r);
    if (!r.ok || !j.ok) {
      showStatus(status, j.error || "Uložení se nezdařilo.", false);
      return;
    }
    showStatus(status, "Uloženo. Polling byl znovu nastaven.", true);
  } catch (err) {
    showStatus(status, String(err.message || err), false);
  } finally {
    btn.disabled = false;
  }
});

$("userForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("userStatus");
  const btn = $("btnCreateUser");
  showStatus(status, "Vytvářím uživatele…", undefined);
  btn.disabled = true;

  const username = String($("newUsername").value || "").trim();
  const password = String($("newPassword").value || "");

  try {
    const r = await apiFetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const j = await parseApiResponse(r);
    if (!r.ok || !j.ok) {
      showStatus(status, j.error || "Vytvoření uživatele se nezdařilo.", false);
      return;
    }
    $("newUsername").value = "";
    $("newPassword").value = "";
    showStatus(status, `Uživatel ${j.user?.username || username} byl vytvořen.`, true);
  } catch (err) {
    showStatus(status, String(err.message || err), false);
  } finally {
    btn.disabled = false;
  }
});

loadConfig().catch((err) => {
  showStatus($("formStatus"), String(err.message || err), false);
});

initTheme();
initLogout();
