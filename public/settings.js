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
  const r = await fetch("/api/config");
  const j = await parseApiResponse(r);
  if (!j.ok) throw new Error(j.error || "Nelze načíst konfiguraci");
  $("goodweHost").value = j.goodweHost || "";
  $("pollIntervalSec").value = String(Math.round((j.pollIntervalMs || 10000) / 1000));
  $("feedInEurPerKwh").value = String(j.feedInEurPerKwh ?? 0.22);
  $("pythonExe").value = j.pythonExe || "python";
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
    feedInEurPerKwh: Number($("feedInEurPerKwh").value),
    pythonExe: $("pythonExe").value.trim(),
  };

  try {
    const r = await fetch("/api/config", {
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

loadConfig().catch((err) => {
  showStatus($("formStatus"), String(err.message || err), false);
});

initTheme();
