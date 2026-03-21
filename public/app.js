/* global WebSocket */

const $ = (id) => document.getElementById(id);
const THEME_KEY = "homeapp_theme";
const LAYOUT_KEY = "homeapp_live_layout_v1";
let currentRange = "day";
let lastBatterySoc = null;

function readLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeLayout(next) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
}

function applySavedPosition(el, key) {
  const map = readLayout();
  const p = map[key];
  if (!p) return;
  if (typeof p.left === "number") el.style.left = `${p.left}px`;
  if (typeof p.top === "number") el.style.top = `${p.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

function initDraggableLiveBlocks() {
  const wrap = document.querySelector(".viz-wrap");
  if (!wrap) return;

  const targets = [
    ["labelGrid", $("labelGrid")],
    ["labelSolar", $("labelSolar")],
    ["labelLoad", $("labelLoad")],
    ["labelBat", $("labelBat")],
    ["metricPhase", document.querySelector(".metric-card-phase")],
    ["metricTemp", document.querySelector(".metric-card-temp")],
    ["metricModes", document.querySelector(".metric-card-modes")],
  ].filter(([, el]) => !!el);

  for (const [key, el] of targets) {
    applySavedPosition(el, key);
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (window.matchMedia("(max-width: 1024px)").matches) return;
      if (getComputedStyle(el).position !== "absolute") return;

      const wrapRect = wrap.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const shiftX = ev.clientX - rect.left;
      const shiftY = ev.clientY - rect.top;

      const move = (x, y) => {
        const maxLeft = Math.max(0, wrapRect.width - rect.width);
        const maxTop = Math.max(0, wrapRect.height - rect.height);
        const left = Math.min(maxLeft, Math.max(0, x - wrapRect.left - shiftX));
        const top = Math.min(maxTop, Math.max(0, y - wrapRect.top - shiftY));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
      };

      const onMove = (e) => move(e.clientX, e.clientY);
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        const left = Number.parseFloat(el.style.left || "0");
        const top = Number.parseFloat(el.style.top || "0");
        const map = readLayout();
        map[key] = { left, top };
        writeLayout(map);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
      ev.preventDefault();
    });
  }
}

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

function initLogout() {
  $("logoutBtn")?.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    window.location.href = "/login.html";
  });
}

function formatPowerW(w) {
  if (w == null || Number.isNaN(w)) return "—";
  const n = Number(w);
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)} kW`;
  return `${n.toFixed(0)} W`;
}
function formatTemp(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Number(v).toFixed(1)} °C`;
}
function formatText(v) {
  if (v == null) return "—";
  const s = String(v).trim();
  return s.length ? s : "—";
}

function formatKwh(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} kWh`;
}

function formatCzk(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)} Kč`;
}

function setFlowIntensity(paths, solarW, loadW, batW, gridW) {
  const sw = Number(solarW || 0);
  const lw = Number(loadW || 0);
  const bw = Number(batW || 0);
  const gw = Number(gridW || 0);

  const th = (w, floor = 0.42, scale = 5000) => {
    const a = Math.min(1, Math.abs(Number(w) || 0) / scale);
    return floor + a * (1 - floor);
  };
  const speed = (w) => {
    const a = Math.min(1, Math.abs(Number(w) || 0) / 4500);
    return `${1.15 - a * 0.65}s`;
  };

  // Přibližné rozdělení napájení zátěže podle okamžitých toků.
  const loadDemand = Math.max(0, lw);
  const gridImport = Math.max(0, -gw);
  const batDischarge = Math.max(0, bw);
  const pvAvail = Math.max(0, sw);

  const gridToLoad = Math.min(loadDemand, gridImport);
  let restLoad = Math.max(0, loadDemand - gridToLoad);
  const batToLoad = Math.min(restLoad, batDischarge);
  restLoad = Math.max(0, restLoad - batToLoad);
  const pvToLoad = Math.min(restLoad, pvAvail);

  const inverterToLoad = pvToLoad + batToLoad + gridToLoad;
  const gridBranchFlow = Math.abs(gw);
  const batteryBranchFlow = Math.abs(bw);
  const pvBranchFlow = Math.abs(sw);

  paths.pvInv.style.opacity = String(th(pvBranchFlow));
  paths.invLoad.style.opacity = String(th(inverterToLoad, 0.38, 4500));
  paths.invBat.style.opacity = String(th(batteryBranchFlow));
  paths.invGrid.style.opacity = String(th(gridBranchFlow));
  paths.pvInv.style.animationDuration = speed(pvBranchFlow);
  paths.invLoad.style.animationDuration = speed(inverterToLoad);
  paths.invBat.style.animationDuration = speed(batteryBranchFlow);
  paths.invGrid.style.animationDuration = speed(gridBranchFlow);

  const dim = (el, w) => {
    el.classList.toggle("dim", !w || Math.abs(w) < 8);
  };
  dim(paths.pvInv, pvBranchFlow);
  dim(paths.invLoad, inverterToLoad);
  dim(paths.invBat, batteryBranchFlow);
  dim(paths.invGrid, gridBranchFlow);

  // Směr toku:
  // - grid_w > 0: export do sítě (inverter -> sloup), < 0: import ze sítě (sloup -> inverter)
  // - battery_w < 0: nabíjení baterie (inverter -> baterie), > 0: vybíjení (baterie -> inverter)
  // - load_w > 0: dodávka do domácnosti (inverter -> dům), < 0: opačný tok (vzácné)
  paths.pvInv.classList.toggle("reverse", sw < 0);
  paths.invGrid.classList.toggle("reverse", gw < 0);
  paths.invBat.classList.toggle("reverse", bw > 0);
  paths.invLoad.classList.toggle("reverse", lw < 0);
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
  const s = payload.sensors || {};

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

  const feedIn = msg.feedInCzkPerKwh ?? payload.feedInCzkPerKwh ?? msg.feedInEurPerKwh ?? payload.feedInEurPerKwh;
  const income =
    n.e_day_kwh != null && feedIn != null
      ? n.e_day_kwh * feedIn
      : (payload.estimatedIncomeCzk ?? payload.estimatedIncomeEur);

  $("kpiProd").textContent = formatKwh(n.e_day_kwh);
  $("kpiCons").textContent = formatKwh(n.e_load_day_kwh);
  $("kpiIncome").textContent = formatCzk(income);

  $("mLoadP1").textContent = formatPowerW(s.load_p1);
  $("mLoadP2").textContent = formatPowerW(s.load_p2);
  $("mLoadP3").textContent = formatPowerW(s.load_p3);
  $("mGridP1").textContent = formatPowerW(s.active_power1);
  $("mGridP2").textContent = formatPowerW(s.active_power2);
  $("mGridP3").textContent = formatPowerW(s.active_power3);
  $("mTempAir").textContent = formatTemp(s.temperature_air);
  $("mTempModule").textContent = formatTemp(s.temperature_module);
  $("mTempHeatsink").textContent = formatTemp(s.temperature);
  $("mWorkMode").textContent = formatText(s.work_mode_label);
  $("mGridMode").textContent = formatText(s.grid_mode_label || s.grid_in_out_label);
  $("mBatteryMode").textContent = formatText(s.battery_mode_label);

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
    if ((j.estimatedIncomeCzk ?? j.estimatedIncomeEur) != null)
      $("kpiIncome").textContent = formatCzk(j.estimatedIncomeCzk ?? j.estimatedIncomeEur);
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
initLogout();
initRangeTabs();
initDraggableLiveBlocks();

fetch("/api/live")
  .then((r) => r.json())
  .then((j) => {
    if (j.ok !== false && j.normalized) applyPayload({ ok: true, ts: j.ts, payload: j });
  })
  .catch(() => {});

loadStats();
connectWs();

