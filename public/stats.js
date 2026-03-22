/* global apiFetch, apiUrl */
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
  redrawDetailBars();
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

function redrawDetailBars() {
  if (window.__lastBreakdownYears) drawBarChart($("barYears"), window.__lastBreakdownYears, "productionKwh", "label", cssVar("--accent", "#3dff7a"));
  if (window.__lastBreakdownMonths) drawBarChart($("barMonths"), window.__lastBreakdownMonths, "productionKwh", "label", "#34d399");
  if (window.__lastBreakdownDays) drawBarChart($("barDays"), window.__lastBreakdownDays, "productionKwh", "label", "#60a5fa");
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

function formatDateShort(ts) {
  if (ts == null || !Number.isFinite(Number(ts))) return "";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
}
function fmt(v, unit = "") {
  if (v == null || Number.isNaN(Number(v))) return "—";
  if (typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  if (Math.abs(n) >= 1000 && unit === "W") return `${(n / 1000).toFixed(2)} kW`;
  if (unit === "%") return `${n.toFixed(0)} %`;
  if (unit === "Hz") return `${n.toFixed(2)} Hz`;
  if (unit === "°C") return `${n.toFixed(1)} °C`;
  if (unit === "kWh") return `${n.toFixed(2)} kWh`;
  if (unit) return `${n.toFixed(1)} ${unit}`;
  return `${n}`;
}

function drawLine(canvas, series, pick, color, min = null, max = null) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = 18;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const drawSeries = series.length === 1 ? [series[0], series[0]] : series;
  const vals = drawSeries.map(pick).filter((v) => v != null && !Number.isNaN(v));
  if (vals.length < 1) {
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
  drawSeries.forEach((s, i) => {
    const v = pick(s);
    if (v == null || Number.isNaN(v)) return;
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, drawSeries.length - 1);
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

function drawBarChart(canvas, items, valueKey, labelKey, color) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 36;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const vals = items.map((it) => Number(it[valueKey])).map((v) => (Number.isFinite(v) ? v : 0));
  if (!vals.length) {
    ctx.fillStyle = cssVar("--muted", "#8b93a5");
    ctx.font = "14px DM Sans, sans-serif";
    ctx.fillText("Žádná data", padL, h / 2);
    return;
  }
  const maxV = Math.max(...vals, 0.001);
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const n = items.length;
  const gap = 4;
  const barW = Math.max(4, (innerW - gap * (n - 1)) / n);

  ctx.strokeStyle = `${cssVar("--accent", "#3dff7a")}22`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  ctx.fillStyle = color || cssVar("--accent", "#3dff7a");
  items.forEach((it, i) => {
    const v = Number(it[valueKey]) || 0;
    const bh = (v / maxV) * innerH;
    const x = padL + i * (barW + gap);
    const y = padT + innerH - bh;
    ctx.fillRect(x, y, barW, bh);
  });

  ctx.fillStyle = cssVar("--muted", "#8b93a5");
  ctx.font = "10px DM Sans, sans-serif";
  ctx.textAlign = "center";
  items.forEach((it, i) => {
    const lab = String(it[labelKey] ?? "");
    const short = lab.length > 10 ? lab.slice(5) : lab;
    const x = padL + i * (barW + gap) + barW / 2;
    ctx.save();
    ctx.translate(x, h - padB + 8);
    ctx.rotate(-0.35);
    ctx.fillText(short, 0, 0);
    ctx.restore();
  });
  ctx.textAlign = "left";

  ctx.fillStyle = cssVar("--muted", "#8b93a5");
  ctx.font = "11px DM Sans, sans-serif";
  ctx.fillText(`max ${maxV.toFixed(1)} kWh`, padL, 14);
}

function renderBreakdownTable(container, items) {
  if (!items.length) {
    container.innerHTML = "<p class=\"stats-lead\">Žádná data.</p>";
    return;
  }
  const rows = items
    .map(
      (it) => `<tr>
      <td>${escapeHtml(it.label || it.key)}</td>
      <td>${formatKwh(it.productionKwh)}</td>
      <td>${formatKwh(it.consumptionKwh)}</td>
      <td>${formatKwh(it.gridExportKwh)}</td>
      <td>${formatKwh(it.gridImportKwh)}</td>
      <td>${formatCzk(it.estimatedIncomeCzk)}</td>
      <td>${it.samples ?? "—"}</td>
    </tr>`
    )
    .join("");
  container.innerHTML = `<table class="stats-data-table">
    <thead><tr>
      <th>Období</th><th>Výroba</th><th>Spotřeba</th><th>Export</th><th>Import</th><th>Příjem</th><th>Vzorky</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Ochrana před HTML odpovědí Apache místo JSON (JSON.parse na řádku 1). */
async function parseJsonRes(res, label) {
  const text = await res.text();
  const t = String(text || "").trim();
  if (!t) {
    throw new Error(
      `${label}: prázdná odpověď (HTTP ${res.status}). Spusťte Node API a případně nastavte localStorage homeapp_api_base na adresu API (např. http://127.0.0.1:3000).`
    );
  }
  const first = t[0];
  if (first !== "{" && first !== "[") {
    throw new Error(
      `${label}: server nevrátil JSON (HTTP ${res.status}). ${t.slice(0, 160)}${t.length > 160 ? "…" : ""}`
    );
  }
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`${label}: ${e && e.message ? e.message : String(e)}`);
  }
}

function fmtMatrixNum(v) {
  if (v == null || Number.isNaN(Number(v))) return "";
  return Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function fmtAvgNum(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
}

function renderMonthlyMatrixHtml(j) {
  const rows = j.rows || [];
  const monthNames = j.monthNames || [];
  if (!rows.length) {
    return "<p class=\"stats-lead\">Žádná uložená data — měsíční matice zatím nejsou k dispozici.</p>";
  }

  const headCols = ["", ...monthNames, "Celkem za rok"];
  const headRow = `<tr>${headCols.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;

  function rowHtml(row, monthsKey, totalKey) {
    const arr = row[monthsKey] || [];
    const nums = monthNames.map((_, i) => fmtMatrixNum(arr[i]));
    const total = row[totalKey];
    return `<tr><td class="stats-matrix-year">${escapeHtml(String(row.year))}</td>${nums
      .map((c) => `<td>${escapeHtml(c)}</td>`)
      .join("")}<td>${escapeHtml(fmtMatrixNum(total))}</td></tr>`;
  }

  const prodTbody = rows.map((r) => rowHtml(r, "productionMonths", "totalProduction")).join("");
  const gridImpTbody = rows.map((r) => rowHtml(r, "gridImportMonths", "totalGridImport")).join("");

  const avgTbody = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(String(r.year))}</td><td>${escapeHtml(
          fmtAvgNum(r.avgDailyProductionKwh)
        )}</td><td>${escapeHtml(fmtAvgNum(r.avgDailyGridImportKwh))}</td></tr>`
    )
    .join("");

  return `
    <div class="stats-matrix-block">
      <h3 class="stats-matrix-block-title">Měsíční výroba (kWh)</h3>
      <div class="stats-table-wrap">
        <table class="stats-matrix-table--excel">
          <thead>${headRow}</thead>
          <tbody>${prodTbody}</tbody>
        </table>
      </div>
    </div>
    <div class="stats-matrix-block">
      <h3 class="stats-matrix-block-title">Měsíční odběr ze sítě (kWh)</h3>
      <div class="stats-table-wrap">
        <table class="stats-matrix-table--excel">
          <thead>${headRow}</thead>
          <tbody>${gridImpTbody}</tbody>
        </table>
      </div>
    </div>
    <div class="stats-matrix-block">
      <h3 class="stats-matrix-block-title">Průměrná denní výroba a odběr ze sítě (kWh/den, děleno počtem dnů se vzorky)</h3>
      <div class="stats-table-wrap">
        <table class="stats-matrix-table--excel stats-matrix-table--avg">
          <thead><tr><th>Rok</th><th>Průměrná denní výroba</th><th>Průměrný denní odběr ze sítě</th></tr></thead>
          <tbody>${avgTbody}</tbody>
        </table>
      </div>
    </div>
  `;
}

async function loadMonthlyMatrix() {
  const r = await apiFetch("/api/stats/monthly-matrix");
  const j = await parseJsonRes(r, "Měsíční matice");
  if (!r.ok || j.ok === false) throw new Error(j.error || "monthly-matrix");
  const wrap = $("matrixExcelWrap");
  if (wrap) wrap.innerHTML = renderMonthlyMatrixHtml(j);
}

function ensureYearSelectsFallback() {
  const yNow = new Date().getFullYear();
  const ys = $("selectYearMonths");
  const yd = $("selectYearDays");
  const mSel = $("selectMonthDays");
  if (ys && !ys.options.length) {
    ys.innerHTML = `<option value="${yNow}">${yNow}</option>`;
  }
  if (yd && !yd.options.length) {
    yd.innerHTML = `<option value="${yNow}">${yNow}</option>`;
  }
  if (mSel && !mSel.options.length) {
    mSel.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
      .map((m) => `<option value="${m}">${m}.</option>`)
      .join("");
    mSel.value = String(new Date().getMonth() + 1);
  }
}

async function loadSnapshot() {
  const r = await apiFetch("/api/stats/snapshot");
  const j = await parseJsonRes(r, "Snapshot");
  if (!r.ok || j.ok === false) {
    console.warn("snapshot:", j.error || r.status);
    return;
  }
  const fill = (pre, b) => {
    if (!b) return;
    const g = (suffix) => $(`${pre}${suffix}`);
    const p = g("Prod");
    if (!p) return;
    p.textContent = formatKwh(b.productionKwh);
    g("Cons").textContent = formatKwh(b.consumptionKwh);
    g("Income").textContent = formatCzk(b.estimatedIncomeCzk);
    g("Samples").textContent = String(b.samples ?? "—");
  };
  fill("snapYear", j.year);
  fill("snapAll", j.allTime);
  fill("snapDay", j.day);
  const sinceEl = $("snapAllSince");
  if (sinceEl) {
    const ft = j.allTime?.firstDataTs;
    sinceEl.textContent =
      ft != null && Number.isFinite(Number(ft))
        ? `Data od ${formatDateShort(ft)} (součet od prvního vzorku)`
        : "Žádná data v databázi.";
  }
}

let cachedYearKeys = [];

async function loadBreakdownYears() {
  const r = await apiFetch("/api/stats/breakdown?granularity=years");
  const j = await parseJsonRes(r, "Rozpad podle let");
  if (!r.ok || j.ok === false) throw new Error(j.error || "breakdown years");
  const items = j.items || [];
  window.__lastBreakdownYears = items;
  cachedYearKeys = items.map((it) => it.key);
  renderBreakdownTable($("tableYearsWrap"), items);
  drawBarChart($("barYears"), items, "productionKwh", "label", cssVar("--accent", "#3dff7a"));

  const ySel = $("selectYearMonths");
  const ySel2 = $("selectYearDays");
  const yNow = new Date().getFullYear();
  const opts = [yNow, ...cachedYearKeys.map(Number).filter((k) => k !== yNow)].sort((a, b) => b - a);
  const uniq = [...new Set(opts.filter((n) => Number.isFinite(n)))];
  ySel.innerHTML = uniq.map((y) => `<option value="${y}">${y}</option>`).join("");
  ySel2.innerHTML = uniq.map((y) => `<option value="${y}">${y}</option>`).join("");
  ySel.value = String(uniq.includes(yNow) ? yNow : uniq[0] ?? yNow);
  ySel2.value = String(uniq.includes(yNow) ? yNow : uniq[0] ?? yNow);

  const mSel = $("selectMonthDays");
  mSel.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    .map((m) => `<option value="${m}">${m}.</option>`)
    .join("");
  mSel.value = String(new Date().getMonth() + 1);
}

async function loadBreakdownMonths() {
  const year = Number($("selectYearMonths").value);
  const r = await apiFetch(`/api/stats/breakdown?granularity=months&year=${encodeURIComponent(year)}`);
  const j = await parseJsonRes(r, "Měsíce v roce");
  if (!r.ok || j.ok === false) throw new Error(j.error || "breakdown months");
  const items = j.items || [];
  window.__lastBreakdownMonths = items;
  renderBreakdownTable($("tableMonthsWrap"), items);
  drawBarChart($("barMonths"), items, "productionKwh", "label", "#34d399");
}

async function loadBreakdownDays() {
  const year = Number($("selectYearDays").value);
  const month = Number($("selectMonthDays").value);
  const r = await apiFetch(
    `/api/stats/breakdown?granularity=days&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`
  );
  const j = await parseJsonRes(r, "Dny v měsíci");
  if (!r.ok || j.ok === false) throw new Error(j.error || "breakdown days");
  const items = j.items || [];
  window.__lastBreakdownDays = items;
  renderBreakdownTable($("tableDaysWrap"), items);
  drawBarChart($("barDays"), items, "productionKwh", "label", "#60a5fa");
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

function metricItem(label, value) {
  return `<div class="metric-item"><span class="metric-key">${label}</span><span class="metric-val">${value}</span></div>`;
}

function metricCard(title, items) {
  return `<section class="metric-card"><h3>${title}</h3>${items.join("")}</section>`;
}

async function loadDetailedMetrics() {
  let r;
  let j;
  try {
    r = await apiFetch("/api/live");
    j = await parseJsonRes(r, "Živá data");
  } catch {
    return;
  }
  if (!r.ok || j.ok === false) return;
  const s = j.sensors || {};
  const grid = metricCard("Panely a síť", [
    metricItem("PV1 napětí", fmt(s.vpv1, "V")),
    metricItem("PV1 proud", fmt(s.ipv1, "A")),
    metricItem("PV2 napětí", fmt(s.vpv2, "V")),
    metricItem("PV2 proud", fmt(s.ipv2, "A")),
    metricItem("Síť L1 napětí", fmt(s.vgrid, "V")),
    metricItem("Síť L1 proud", fmt(s.igrid, "A")),
  ]);
  const freq = metricCard("Frekvence", [
    metricItem("Síť L1", fmt(s.fgrid, "Hz")),
    metricItem("Síť L2", fmt(s.fgrid2, "Hz")),
    metricItem("Síť L3", fmt(s.fgrid3, "Hz")),
  ]);
  const phasePower = metricCard("Výkon po fázích", [
    metricItem("Load L1", fmt(s.load_p1, "W")),
    metricItem("Load L2", fmt(s.load_p2, "W")),
    metricItem("Load L3", fmt(s.load_p3, "W")),
    metricItem("Grid P1", fmt(s.active_power1, "W")),
    metricItem("Grid P2", fmt(s.active_power2, "W")),
    metricItem("Grid P3", fmt(s.active_power3, "W")),
  ]);
  const temp = metricCard("Teploty střídače", [
    metricItem("Teplota vzduch", fmt(s.temperature_air, "°C")),
    metricItem("Teplota modul", fmt(s.temperature_module, "°C")),
    metricItem("Teplota chladič", fmt(s.temperature, "°C")),
  ]);
  const modes = metricCard("Režimy střídače/baterie", [
    metricItem("Režim práce", fmt(s.work_mode_label)),
    metricItem("Režim sítě", fmt(s.grid_mode_label || s.grid_in_out_label)),
    metricItem("Režim baterie", fmt(s.battery_mode_label)),
  ]);
  const diag = metricCard("Chyby a diagnostika", [
    metricItem("Warning code", fmt(s.warning_code)),
    metricItem("Error codes", fmt(s.error_codes)),
    metricItem("Diag status", fmt(s.diagnose_result_label || s.diagnose_result)),
  ]);
  const energy = metricCard("Denní / životní energie", [
    metricItem("PV den", fmt(s.e_day, "kWh")),
    metricItem("PV celkem", fmt(s.e_total, "kWh")),
    metricItem("Load den", fmt(s.e_load_day, "kWh")),
    metricItem("Load celkem", fmt(s.e_load_total, "kWh")),
    metricItem("Export den", fmt(s.e_day_exp, "kWh")),
    metricItem("Export celkem", fmt(s.e_total_exp, "kWh")),
    metricItem("Import den", fmt(s.e_day_imp, "kWh")),
    metricItem("Import celkem", fmt(s.e_total_imp, "kWh")),
    metricItem("Bat charge den", fmt(s.e_bat_charge_day, "kWh")),
    metricItem("Bat charge celkem", fmt(s.e_bat_charge_total, "kWh")),
    metricItem("Bat discharge den", fmt(s.e_bat_discharge_day, "kWh")),
    metricItem("Bat discharge celkem", fmt(s.e_bat_discharge_total, "kWh")),
  ]);
  $("metricsGrid").innerHTML = [grid, freq, phasePower, temp, modes, diag, energy].join("");
}

async function loadStats() {
  const r = await apiFetch(`/api/stats?range=${encodeURIComponent(currentRange)}`);
  const j = await parseJsonRes(r, "Statistiky");
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
  const r = await apiFetch(`/api/series-range?range=${encodeURIComponent(currentRange)}`);
  const j = await parseJsonRes(r, "Časová řada");
  if (!r.ok || j.ok === false) throw new Error(j.error || "Nelze načíst graf");
  drawCharts(j.series || []);
  let bucketInfo = "";
  if (j.bucketKind === "calendarMonth") bucketInfo = " · seskupení: kalendářní měsíc (i rozpracovaný)";
  else if (j.bucketKind === "calendarYear") bucketInfo = " · seskupení: kalendářní rok (i rozpracovaný)";
  else if (j.bucketMs != null && Number(j.bucketMs) > 0)
    bucketInfo = ` · bucket ${(Number(j.bucketMs) / 60000).toFixed(0)} min`;
  $("statsInfo").textContent = `Rozsah: ${currentRange.toUpperCase()}${bucketInfo}`;
}

function bindTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab[data-range]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", async () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentRange = tab.dataset.range || "day";
      $("statsExportXls").href = apiUrl(`/api/export/xls?range=${encodeURIComponent(currentRange)}`);
      await Promise.all([loadStats(), loadSeries()]);
    });
  });
}

(async function init() {
  initTheme();
  initLogout();
  bindTabs();
  $("statsExportXls").href = apiUrl(`/api/export/xls?range=${encodeURIComponent(currentRange)}`);
  await Promise.all([loadStats(), loadSeries()]);
  try {
    await loadSnapshot();
  } catch (e) {
    console.warn(e);
  }
  try {
    await loadMonthlyMatrix();
  } catch (e) {
    console.warn(e);
    const mw = $("matrixExcelWrap");
    if (mw) mw.innerHTML = `<p class="stats-lead">${escapeHtml(String(e.message || e))}</p>`;
  }
  try {
    await loadBreakdownYears();
    await loadBreakdownMonths();
    await loadBreakdownDays();
  } catch (e) {
    console.warn(e);
    $("tableYearsWrap").innerHTML = `<p class="stats-lead">${escapeHtml(String(e.message || e))}</p>`;
    ensureYearSelectsFallback();
  }
  $("btnLoadMonths")?.addEventListener("click", () => loadBreakdownMonths().catch(console.warn));
  $("btnLoadDays")?.addEventListener("click", () => loadBreakdownDays().catch(console.warn));
  await loadDetailedMetrics();
  setInterval(loadDetailedMetrics, 15000);
})();
