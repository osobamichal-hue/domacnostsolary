/* global WebSocket */

const $ = (id) => document.getElementById(id);
const THEME_KEY = "homeapp_theme";
let currentRange = "day";
let lastBatterySoc = null;

function updateHouseImages(soc) {
  const light = $("houseImgLight");
  const dark = $("houseImgDark");
  if (!light || !dark) return;
  // Dočasně používáme jen full-size podklady.
  // Varianty 220x122 jsou pro hlavní panel příliš malé a rozmazávají se.
  light.src = "/pict/DumSvetla.png";
  dark.src = "/pict/DumTmava.png";
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = $("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "🌞" : "🌙";
  updateHouseImages(lastBatterySoc);
  drawChart();
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

function formatPowerW(w) {
  if (w == null || Number.isNaN(w)) return "—";
  const n = Number(w);
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)} kW`;
  return `${n.toFixed(0)} W`;
}

function formatKwh(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} kWh`;
}

function formatEur(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} €`;
}

function setFlowIntensity(paths, solarW, loadW, batW, gridW) {
  const th = (w) => {
    const a = Math.min(1, Math.abs(Number(w) || 0) / 4000);
    return 0.15 + a * 0.85;
  };
  paths.pvInv.style.opacity = String(th(solarW));
  paths.invLoad.style.opacity = String(th(loadW));
  paths.invBat.style.opacity = String(th(batW));
  paths.invGrid.style.opacity = String(th(gridW));

  const dim = (el, w) => {
    el.classList.toggle("dim", !w || Math.abs(w) < 5);
  };
  dim(paths.pvInv, solarW);
  dim(paths.invLoad, loadW);
  dim(paths.invBat, batW);
  dim(paths.invGrid, gridW);

  // Směr toku:
  // - grid_w > 0: export do sítě (inverter -> sloup), < 0: import ze sítě (sloup -> inverter)
  // - battery_w < 0: nabíjení baterie (inverter -> baterie), > 0: vybíjení (baterie -> inverter)
  paths.invGrid.classList.toggle("reverse", Number(gridW || 0) < 0);
  const bw = Number(batW || 0);
  paths.invBat.classList.toggle("reverse", bw > 0);
}

const paths = {
  pvInv: document.getElementById("pathPvInv"),
  invLoad: document.getElementById("pathInvLoad"),
  invBat: document.getElementById("pathInvBat"),
  invGrid: document.getElementById("pathInvGrid"),
};

const series = {
  t: [],
  solar: [],
  maxPoints: 120,
};

function pushSample(t, n) {
  if (!n) return;
  series.t.push(t);
  series.solar.push(n.solar_w ?? null);
  if (series.t.length > series.maxPoints) {
    series.t.shift();
    series.solar.shift();
  }
  drawChart();
}

function drawChart() {
  const canvas = $("chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const vals = series.solar.filter((v) => v != null);
  if (vals.length < 2) {
    ctx.fillStyle = cssVar("--muted", "#8b93a5");
    ctx.font = "14px DM Sans, sans-serif";
    ctx.fillText("Čekám na data…", 16, h / 2);
    return;
  }
  const min = 0;
  const max = Math.max(...vals, 100);
  const pad = 16;
  const accent = cssVar("--accent", "#3dff7a");
  ctx.strokeStyle = `${accent}44`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + ((h - 2 * pad) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.solar.forEach((v, i) => {
    if (v == null) return;
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, series.solar.length - 1);
    const y = pad + (h - 2 * pad) * (1 - (v - min) / (max - min || 1));
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function applyPayload(msg) {
  const payload = msg.payload || msg;
  const ok = msg.ok !== false && payload.ok !== false;
  const n = payload.normalized || {};

  if (!ok && payload.error) {
    $("modelLine").textContent = String(payload.error);
  }

  $("connStatus").textContent = ok ? "Živá data" : "Chyba čtení";
  $("connStatus").classList.toggle("ok", ok);
  $("connStatus").classList.toggle("err", !ok);

  $("valSolar").textContent = formatPowerW(n.solar_w);
  $("valLoad").textContent = formatPowerW(n.load_w);
  $("valGrid").textContent = formatPowerW(n.grid_w);
  $("valBat").textContent = formatPowerW(n.battery_w);
  $("valBatSoc").textContent =
    n.battery_soc_pct != null ? `${Number(n.battery_soc_pct).toFixed(0)} %` : "—";
  lastBatterySoc = n.battery_soc_pct;
  updateHouseImages(lastBatterySoc);

  setFlowIntensity(paths, n.solar_w, n.load_w, n.battery_w, n.grid_w);

  const feedIn = msg.feedInEurPerKwh ?? payload.feedInEurPerKwh;
  const income =
    n.e_day_kwh != null && feedIn != null
      ? n.e_day_kwh * feedIn
      : payload.estimatedIncomeEur;

  $("kpiProd").textContent = formatKwh(n.e_day_kwh);
  $("kpiCons").textContent = formatKwh(n.e_load_day_kwh);
  $("kpiIncome").textContent = formatEur(income);

  if (ok && payload.model_name) {
    $("modelLine").textContent = `${payload.model_name}${
      payload.serial_number ? " · " + String(payload.serial_number).slice(0, 12) : ""
    }`;
  }

  pushSample(msg.ts || Date.now(), n);
}

async function loadStats() {
  try {
    const r = await fetch(`/api/stats?range=${encodeURIComponent(currentRange)}`);
    const j = await r.json();
    if (j.productionKwh != null) $("kpiProd").textContent = formatKwh(j.productionKwh);
    if (j.consumptionKwh != null) $("kpiCons").textContent = formatKwh(j.consumptionKwh);
    if (j.estimatedIncomeEur != null)
      $("kpiIncome").textContent = formatEur(j.estimatedIncomeEur);
    const exportBtn = $("exportXlsBtn");
    if (exportBtn) exportBtn.href = `/api/export/xls?range=${encodeURIComponent(currentRange)}`;
  } catch {
    /* ignore */
  }
}

function initRangeTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab[data-range]"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentRange = tab.dataset.range || "day";
      loadStats();
    });
  });
}

function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener("open", () => {
    $("connStatus").textContent = "WS připojeno";
  });

  ws.addEventListener("message", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.type === "reading") applyPayload(data);
    } catch {
      /* ignore */
    }
  });

  ws.addEventListener("close", () => {
    $("connStatus").textContent = "Obnovuji spojení…";
    $("connStatus").classList.remove("ok");
    setTimeout(connectWs, 2000);
  });
}

// Mock počasí (volitelně lze napojit na API)
$("weatherTemp").textContent = "8 °C";
initTheme();
initRangeTabs();

fetch("/api/live")
  .then((r) => r.json())
  .then((j) => {
    if (j.ok !== false && j.normalized) applyPayload({ ok: true, ts: j.ts, payload: j });
  })
  .catch(() => {});

loadStats();
connectWs();

