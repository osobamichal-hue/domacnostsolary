const $ = (id) => document.getElementById(id);
const THEME_KEY = "homeapp_theme";
let currentRange = "day";

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "🌞" : "🌙";
  drawCharts(window.__lastSeries || []);
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

function formatKwh(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} kWh`;
}
function formatCzk(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} Kč`;
}
function formatPct(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(1)} %`;
}

function drawLine(canvas, series, pick, color, min = null, max = null) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 18;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const vals = series.map(pick).filter((v) => v != null && !Number.isNaN(v));
  if (vals.length < 2) {
    ctx.fillStyle = cssVar("--muted", "#8b93a5");
    ctx.font = "14px DM Sans, sans-serif";
    ctx.fillText("Čekám na data…", 16, h / 2);
    return;
  }

  const lo = min == null ? Math.min(...vals) : min;
  const hi = max == null ? Math.max(...vals) : max;
  const lo2 = lo === hi ? lo - 1 : lo;
  const hi2 = lo === hi ? hi + 1 : hi;

  ctx.strokeStyle = `${cssVar("--accent", "#3dff7a")}33`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((h - 2 * pad) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((s, i) => {
    const v = pick(s);
    if (v == null || Number.isNaN(v)) return;
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, series.length - 1);
    const y = pad + (h - 2 * pad) * (1 - (v - lo2) / (hi2 - lo2));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawCharts(series) {
  window.__lastSeries = series;
  drawLine($("powerChart"), series, (s) => s.solar_w, cssVar("--accent", "#3dff7a"), 0, null);
  drawLine($("socChart"), series, (s) => s.battery_soc_pct, "#60a5fa", 0, 100);
}

function drawRatioChart(selfPct, gridPct) {
  const canvas = $("ratioChart");
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const selfV = Number(selfPct);
  const gridV = Number(gridPct);
  if (Number.isNaN(selfV) || Number.isNaN(gridV)) {
    ctx.fillStyle = cssVar("--muted", "#8b93a5");
    ctx.font = "14px DM Sans, sans-serif";
    ctx.fillText("Poměr není dostupný (chybí import/export data).", 16, h / 2);
    return;
  }

  const total = Math.max(0.001, selfV + gridV);
  const pSelf = Math.max(0, Math.min(1, selfV / total));
  const pGrid = 1 - pSelf;

  const x = 26;
  const y = 72;
  const barW = w - 52;
  const barH = 34;
  const selfW = barW * pSelf;
  const gridW = barW * pGrid;

  ctx.fillStyle = "#16a34a";
  ctx.fillRect(x, y, selfW, barH);
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(x + selfW, y, gridW, barH);
  ctx.strokeStyle = cssVar("--border", "#252a35");
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, barW, barH);

  ctx.fillStyle = cssVar("--text", "#e8eaef");
  ctx.font = "600 14px DM Sans, sans-serif";
  ctx.fillText(`Vlastní spotřeba: ${formatPct(selfPct)}`, x, y - 12);
  ctx.fillText(`Spotřeba ze sítě: ${formatPct(gridPct)}`, x + 320, y - 12);
}

async function loadStats() {
  const r = await fetch(`/api/stats?range=${encodeURIComponent(currentRange)}`);
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || "Nelze načíst statistiky");
  $("sProd").textContent = formatKwh(j.productionKwh);
  $("sCons").textContent = formatKwh(j.consumptionKwh);
  $("sSelf").textContent = formatKwh(j.selfConsumptionKwh);
  $("sExport").textContent = formatKwh(j.gridExportKwh);
  $("sImport").textContent = formatKwh(j.gridImportKwh);
  $("sIncome").textContent = formatCzk(j.estimatedIncomeCzk ?? j.estimatedIncomeEur);
  $("sSamples").textContent = String(j.samples ?? "—");
  drawRatioChart(j.selfSufficiencyPct, j.gridDependencyPct);
}

async function loadSeries() {
  const r = await fetch(`/api/series-range?range=${encodeURIComponent(currentRange)}`);
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || "Nelze načíst graf");
  drawCharts(j.series || []);
  $("statsInfo").textContent = `Rozsah: ${currentRange.toUpperCase()} · bucket ${(j.bucketMs / 60000).toFixed(0)} min`;
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab[data-range]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentRange = tab.dataset.range || "day";
      $("statsExportXls").href = `/api/export/xls?range=${encodeURIComponent(currentRange)}`;
      await Promise.all([loadStats(), loadSeries()]);
    });
  });
}

(async function init() {
  initTheme();
  bindTabs();
  $("statsExportXls").href = `/api/export/xls?range=${encodeURIComponent(currentRange)}`;
  await Promise.all([loadStats(), loadSeries()]);
})();
