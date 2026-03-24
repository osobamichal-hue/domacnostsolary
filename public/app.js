/* global WebSocket, apiFetch, apiUrl, apiWsUrl */

const $ = (id) => document.getElementById(id);
/**
 * Fallback směru, když chybí battery_mode_label: GoodWe pbattery1 záporné = nabíjení.
 */
const BATTERY_GOODWE_SIGN = true;
const THEME_KEY = "homeapp_theme";
const LAYOUT_KEY = "homeapp_live_layout_shared_v2";
const LEGACY_LAYOUT_KEYS = [
  "homeapp_live_layout_v1",
  "homeapp_live_layout_v1_dark",
  "homeapp_live_layout_v1_light",
];
let lastBatterySoc = null;
let lastBatteryModeLabel = null;

function sanitizeLayoutMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== "object") continue;
    const left = Number(val.left);
    const top = Number(val.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
    out[key] = { left, top };
  }
  return out;
}

function readLayoutRaw(key) {
  try {
    return sanitizeLayoutMap(JSON.parse(localStorage.getItem(key) || "{}"));
  } catch {
    return {};
  }
}

function writeLayout(next) {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(sanitizeLayoutMap(next)));
}

function migrateLayoutIfNeeded() {
  if (localStorage.getItem(LAYOUT_KEY) != null) return;
  let merged = {};
  for (const key of LEGACY_LAYOUT_KEYS) {
    const oldMap = readLayoutRaw(key);
    if (Object.keys(oldMap).length) merged = { ...merged, ...oldMap };
  }
  if (Object.keys(merged).length) writeLayout(merged);
}

function readLayout() {
  migrateLayoutIfNeeded();
  return readLayoutRaw(LAYOUT_KEY);
}

function isMobileVizLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function clearInlinePosition(el) {
  el.style.left = "";
  el.style.top = "";
  el.style.right = "";
  el.style.bottom = "";
}

function applySavedPosition(el, key) {
  if (isMobileVizLayout()) {
    clearInlinePosition(el);
    return;
  }
  const map = readLayout();
  const p = map[key];
  if (!p) return;
  if (typeof p.left === "number") el.style.left = `${p.left}px`;
  if (typeof p.top === "number") el.style.top = `${p.top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

function syncVizLayoutForViewport() {
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
    ["metricBoiler", document.querySelector(".metric-card-boiler")],
  ].filter(([, el]) => !!el);
  for (const [key, el] of targets) applySavedPosition(el, key);
}

function initDraggableLiveBlocks() {
  const wrap = document.querySelector(".viz-wrap");
  const stage = document.querySelector(".viz-stage");
  if (!wrap) return;

  const targets = [
    ["labelGrid", $("labelGrid")],
    ["labelSolar", $("labelSolar")],
    ["labelLoad", $("labelLoad")],
    ["labelBat", $("labelBat")],
    ["metricPhase", document.querySelector(".metric-card-phase")],
    ["metricTemp", document.querySelector(".metric-card-temp")],
    ["metricModes", document.querySelector(".metric-card-modes")],
    ["metricBoiler", document.querySelector(".metric-card-boiler")],
  ].filter(([, el]) => !!el);

  for (const [key, el] of targets) {
    applySavedPosition(el, key);
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (isMobileVizLayout()) return;
      if (getComputedStyle(el).position !== "absolute") return;

      const boundsEl = key.startsWith("label") && stage ? stage : wrap;
      const wrapRect = boundsEl.getBoundingClientRect();
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
      const persistPosition = () => {
        const nowRect = el.getBoundingClientRect();
        const left = Math.min(
          Math.max(0, nowRect.left - wrapRect.left),
          Math.max(0, wrapRect.width - nowRect.width)
        );
        const top = Math.min(
          Math.max(0, nowRect.top - wrapRect.top),
          Math.max(0, wrapRect.height - nowRect.height)
        );
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        const map = readLayout();
        map[key] = { left, top };
        writeLayout(map);
      };
      const finishDrag = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", finishDrag);
        document.removeEventListener("pointercancel", finishDrag);
        persistPosition();
      };

      el.setPointerCapture?.(ev.pointerId);
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", finishDrag, { once: true });
      document.addEventListener("pointercancel", finishDrag, { once: true });
      ev.preventDefault();
    });
  }

  let lastMobile = isMobileVizLayout();
  window.addEventListener("resize", () => {
    const now = isMobileVizLayout();
    if (now !== lastMobile) {
      lastMobile = now;
      syncVizLayoutForViewport();
    }
  });
}

/** 01 = vybito … 04 = plně nabitá; stejné prahy SOC jako dřív (25 / 50 / 75 %). */
function batterySocHouseIndex(socPct) {
  if (socPct == null || Number.isNaN(Number(socPct))) return 1;
  const clamped = Math.max(0, Math.min(100, Number(socPct)));
  if (clamped >= 75) return 4;
  if (clamped >= 50) return 3;
  if (clamped >= 25) return 2;
  return 1;
}

function lightHouseSrcByBatterySocPct(socPct) {
  const idx = batterySocHouseIndex(socPct);
  const name = `Svetle_bez_drah_${String(idx).padStart(2, "0")}.png`;
  return encodeURI(`/pict/toky/${name}`);
}

function darkHouseSrcByBatterySocPct(socPct) {
  const idx = batterySocHouseIndex(socPct);
  const name = `Tmavé_bez_drah_${String(idx).padStart(2, "0")}.png`;
  return encodeURI(`/pict/toky/${name}`);
}

function updateHouseImages(soc) {
  const light = $("houseImgLight");
  const dark = $("houseImgDark");
  if (!light || !dark) return;
  light.src = lightHouseSrcByBatterySocPct(soc);
  dark.src = darkHouseSrcByBatterySocPct(soc);
}

/** Bezpečné číslo z API (špatný typ / NaN nesmí vypnout tok). */
function parseFlowWatts(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Barva ikony bojleru podle teploty vody (0–85 °C): modrá → žlutá → oranžová → červená.
 */
function boilerTempToCssColor(tempC) {
  const raw = Number(tempC);
  if (!Number.isFinite(raw)) return "var(--muted)";
  const t = Math.max(0, Math.min(85, raw)) / 85;
  let r;
  let g;
  let b;
  if (t < 1 / 3) {
    const u = t * 3;
    r = Math.round(40 + (255 - 40) * u);
    g = Math.round(90 + (240 - 90) * u);
    b = Math.round(220 + (70 - 220) * u);
  } else if (t < 2 / 3) {
    const u = (t - 1 / 3) * 3;
    r = 255;
    g = Math.round(240 + (120 - 240) * u);
    b = Math.round(70 + (35 - 70) * u);
  } else {
    const u = (t - 2 / 3) * 3;
    r = Math.round(255 + (215 - 255) * u);
    g = Math.round(120 + (45 - 120) * u);
    b = Math.round(35 + (38 - 35) * u);
  }
  return `rgb(${r},${g},${b})`;
}

function updateBoilerCard(payload, s) {
  const svg = document.querySelector(".metric-card-boiler .boiler-card__icon-svg");
  const mainEl = $("boilerTempMain");
  const currEl = $("boilerTempCurr");
  const tgtEl = $("boilerTempTarget");
  const statusRow = $("boilerStatusRow");
  const statusText = $("boilerStatusText");
  const heatLine = $("boilerHeatLine");
  const f1 = $("boilerThermoFill1");
  const f2 = $("boilerThermoFill2");
  const f3 = $("boilerThermoFill3");
  const w1 = $("boilerW1");
  const w2 = $("boilerW2");
  const w3 = $("boilerW3");
  if (!currEl || !mainEl || !statusRow || !statusText) return;

  const lan = payload.lan_web;
  let temp = null;
  let target = null;
  let active = null;
  let heat = null;
  if (lan && lan.ok && lan.data && typeof lan.data === "object") {
    const d = lan.data;
    if (d.boiler_water_temp_c != null) temp = Number(d.boiler_water_temp_c);
    if (d.boiler_target_temp_c != null) target = Number(d.boiler_target_temp_c);
    if (d.boiler_status_active === true || d.boiler_status_active === false) active = d.boiler_status_active;
    if (d.boiler_switch_on === true || d.boiler_switch_on === false) heat = d.boiler_switch_on;
  }

  if (temp != null && Number.isFinite(temp)) {
    currEl.textContent = temp.toFixed(1);
    if (target != null && Number.isFinite(target)) {
      tgtEl.textContent = target.toFixed(0);
      mainEl.classList.remove("boiler-card__temp-main--single");
    } else {
      tgtEl.textContent = "";
      mainEl.classList.add("boiler-card__temp-main--single");
    }
    if (svg) svg.style.color = boilerTempToCssColor(temp);
  } else {
    currEl.textContent = "—";
    tgtEl.textContent = "";
    mainEl.classList.add("boiler-card__temp-main--single");
    if (svg) svg.style.color = "var(--muted)";
  }

  statusRow.classList.remove(
    "boiler-card__status--active",
    "boiler-card__status--inactive",
    "boiler-card__status--unknown"
  );
  if (active === true) {
    statusRow.classList.add("boiler-card__status--active");
    statusText.textContent = "aktivní";
  } else if (active === false) {
    statusRow.classList.add("boiler-card__status--inactive");
    statusText.textContent = "neaktivní";
  } else {
    statusRow.classList.add("boiler-card__status--unknown");
    statusText.textContent = "stav neznámý";
  }

  if (heatLine) {
    if (heat === true) heatLine.textContent = "Ohřev: zapnuto";
    else if (heat === false) heatLine.textContent = "Ohřev: vypnuto";
    else heatLine.textContent = "";
  }

  const p1 = Math.abs(parseFlowWatts(s.load_p1));
  const p2 = Math.abs(parseFlowWatts(s.load_p2));
  const p3 = Math.abs(parseFlowWatts(s.load_p3));
  const max = Math.max(p1, p2, p3, 1);
  if (f1) f1.style.width = `${(p1 / max) * 100}%`;
  if (f2) f2.style.width = `${(p2 / max) * 100}%`;
  if (f3) f3.style.width = `${(p3 / max) * 100}%`;

  if (w1) w1.textContent = formatPowerW(s.load_p1);
  if (w2) w2.textContent = formatPowerW(s.load_p2);
  if (w3) w3.textContent = formatPowerW(s.load_p3);
}

/** Součet úseků ve stroke-dasharray (20 + 14) — perioda opakování vzoru. */
const FLOW_DASH_PERIOD = 34;

const flowDashByPath = new Map();
let flowDashRaf = 0;
let flowDashLastTs = 0;

function flowDashStop() {
  if (flowDashRaf) {
    cancelAnimationFrame(flowDashRaf);
    flowDashRaf = 0;
  }
  flowDashLastTs = 0;
}

function flowDashTick(ts) {
  flowDashRaf = 0;
  if (flowDashByPath.size === 0) {
    flowDashLastTs = 0;
    return;
  }
  const dt = flowDashLastTs ? Math.min(0.1, (ts - flowDashLastTs) / 1000) : 1 / 60;
  flowDashLastTs = ts;

  for (const [path, st] of flowDashByPath) {
    if (!path.isConnected) {
      flowDashByPath.delete(path);
      continue;
    }
    const dir = st.reverse ? 1 : -1;
    let o = st.offset + dir * st.pxPerSec * dt;
    o %= FLOW_DASH_PERIOD;
    if (o < 0) o += FLOW_DASH_PERIOD;
    st.offset = o;
    /* Inline styl má přednost před CSS .flow-path-* { stroke-dashoffset: 0 } — atribut setAttribute se jinak nepřekreslí. */
    path.style.strokeDashoffset = String(o);
  }

  if (flowDashByPath.size > 0) flowDashRaf = requestAnimationFrame(flowDashTick);
}

function flowDashPxPerSecFromDur(durSec) {
  return 48 / Math.max(0.25, Number(durSec) || 0.68);
}

/**
 * Animace toku: mění atribut stroke-dashoffset (CSS @keyframes na SVG path často neběží).
 * @param {SVGPathElement | null} path
 * @param {{ active: boolean, reverse?: boolean, durSec?: number }} opts
 */
function setFlowPathDashAnim(path, opts) {
  if (!path) return;
  const { active, reverse = false, durSec = 0.68 } = opts;

  if (!active) {
    flowDashByPath.delete(path);
    path.style.removeProperty("stroke-dashoffset");
    if (flowDashByPath.size === 0) flowDashStop();
    return;
  }

  let pxPerSec = flowDashPxPerSecFromDur(durSec);
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    pxPerSec *= 0.4;
  }
  const st = flowDashByPath.get(path) || { offset: 0, pxPerSec, reverse: !!reverse };
  st.pxPerSec = pxPerSec;
  st.reverse = !!reverse;
  flowDashByPath.set(path, st);

  if (!flowDashRaf) flowDashRaf = requestAnimationFrame(flowDashTick);
}

/**
 * Režim baterie ze střídače (EN/CZ). discharge před charge kvůli „discharge“ vs „charge“.
 */
function batteryModeFromLabel(label) {
  const t = String(label || "").toLowerCase();
  if (!t.trim()) return null;
  if (t.includes("discharge") || t.includes("vybíjení") || t.includes("vybij")) return "discharge";
  if (t.includes("charge") || t.includes("nabíjení") || t.includes("nabij")) return "charge";
  if (t.includes("standby") || t.includes("nečinn") || t.includes("idle") || /\boff\b/.test(t))
    return "standby";
  return null;
}

/** Když chybí popisek režimu: GoodWe záporné = nabíjení, kladné = vybíjení. */
function batteryModeFromPower(w) {
  const x = parseFlowWatts(w);
  if (Math.abs(x) <= 0.5) return null;
  if (BATTERY_GOODWE_SIGN) return x < 0 ? "charge" : "discharge";
  return x > 0 ? "charge" : "discharge";
}

/** Tok panely → měnič: jen při výrobě (kladné solar_w), jeden směr animace. */
function updatePvInverterFlow(solarW) {
  const path = $("pathPvInv");
  const under = document.querySelector(".flow-under-pv");
  if (!path) return;
  const w = parseFlowWatts(solarW);
  const active = w > 8;
  path.classList.toggle("dim", !active);
  if (under) under.classList.toggle("dim", !active);

  if (!active) {
    path.style.opacity = "";
    setFlowPathDashAnim(path, { active: false });
    return;
  }

  const th = Math.min(1, Math.abs(w) / 5000);
  path.style.opacity = String(0.42 + th * 0.58);
  const a = Math.min(1, Math.abs(w) / 4500);
  const durSec = 1.15 - a * 0.65;
  setFlowPathDashAnim(path, { active: true, reverse: false, durSec });
}

/**
 * Tok měnič ↔ baterie: směr podle režimu (Charge / Discharge / Standby).
 * Cesta shora dolů: dopředu = energie do baterie, reverse = z baterie.
 */
function updateBatteryInverterFlow(batteryW, batteryModeLabel) {
  const path = $("pathInvBat");
  const under = document.querySelector(".flow-under-bat");
  if (!path) return;
  const w = parseFlowWatts(batteryW);
  let mode = batteryModeFromLabel(batteryModeLabel);
  if (mode == null) mode = batteryModeFromPower(w);

  let active = false;
  let discharging = false;

  if (mode === "standby") {
    active = false;
    discharging = false;
  } else if (mode === "charge") {
    discharging = false;
    active = true;
  } else if (mode === "discharge") {
    discharging = true;
    active = true;
  } else {
    discharging = BATTERY_GOODWE_SIGN ? w > 0 : w < 0;
    active = Math.abs(w) > 8;
  }

  path.classList.toggle("dim", !active);
  if (under) under.classList.toggle("dim", !active);
  path.classList.toggle("reverse", discharging);

  if (!active) {
    path.style.opacity = "";
    setFlowPathDashAnim(path, { active: false });
    return;
  }

  const th = Math.min(1, Math.abs(w) / 5000);
  path.style.opacity = String(0.42 + th * 0.58);
  const a = Math.min(1, Math.abs(w) / 4500);
  const durSec = 1.15 - a * 0.65;
  setFlowPathDashAnim(path, { active: true, reverse: discharging, durSec });
}

/**
 * Tok měnič → zátěž (domácnost). Kladné load_w = odběr z měniče; vzácně záporné → reverse.
 */
function updateLoadInverterFlow(loadW) {
  const path = $("pathInvLoad");
  const under = document.querySelector(".flow-under-load");
  if (!path) return;
  const w = parseFlowWatts(loadW);
  const active = Math.abs(w) > 8;
  path.classList.toggle("dim", !active);
  if (under) under.classList.toggle("dim", !active);
  path.classList.toggle("reverse", w < 0);

  if (!active) {
    path.style.opacity = "";
    setFlowPathDashAnim(path, { active: false });
    return;
  }

  const th = Math.min(1, Math.abs(w) / 15000);
  path.style.opacity = String(0.42 + th * 0.58);
  const a = Math.min(1, Math.abs(w) / 12000);
  const durSec = 1.15 - a * 0.65;
  setFlowPathDashAnim(path, { active: true, reverse: w < 0, durSec });
}

/**
 * Tok měnič ↔ síť: kladné grid_w = vývoz do sítě (po cestě k sloupu),
 * záporné = odběr ze sítě → reverse animace.
 */
function updateGridInverterFlow(gridW) {
  const path = $("pathInvGrid");
  const under = document.querySelector(".flow-under-grid");
  if (!path) return;
  const w = parseFlowWatts(gridW);
  const active = Math.abs(w) > 8;
  path.classList.toggle("dim", !active);
  if (under) under.classList.toggle("dim", !active);
  path.classList.toggle("reverse", w < 0);

  if (!active) {
    path.style.opacity = "";
    setFlowPathDashAnim(path, { active: false });
    return;
  }

  const th = Math.min(1, Math.abs(w) / 15000);
  path.style.opacity = String(0.42 + th * 0.58);
  const a = Math.min(1, Math.abs(w) / 12000);
  const durSec = 1.15 - a * 0.65;
  setFlowPathDashAnim(path, { active: true, reverse: w < 0, durSec });
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
  updateBatterySocUi(lastBatterySoc, lastBatteryModeLabel);
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
      await apiFetch("/api/auth/logout", { method: "POST" });
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

const GRID_NEG_CLASS = "label-val--grid-neg";
const LOAD_W_TIER_CLASSES = [
  "label-val--load-w-green",
  "label-val--load-w-yellow",
  "label-val--load-w-orange",
  "label-val--load-w-red",
];

/** Síť: záporný výkon (odběr) → červeně. */
function applyGridLabelStyle(el, gridW) {
  if (!el) return;
  el.classList.remove(GRID_NEG_CLASS);
  if (gridW == null || Number.isNaN(Number(gridW))) return;
  if (Number(gridW) < 0) el.classList.add(GRID_NEG_CLASS);
}

/**
 * Zátěž: <800 W zelená, <1,5 kW žlutá, <2,2 kW oranžová, jinak červená (abs. hodnota).
 */
function applyLoadLabelStyle(el, loadW) {
  if (!el) return;
  LOAD_W_TIER_CLASSES.forEach((c) => el.classList.remove(c));
  if (loadW == null || Number.isNaN(Number(loadW))) return;
  const a = Math.abs(Number(loadW));
  if (a < 800) el.classList.add("label-val--load-w-green");
  else if (a < 1500) el.classList.add("label-val--load-w-yellow");
  else if (a < 2200) el.classList.add("label-val--load-w-orange");
  else el.classList.add("label-val--load-w-red");
}

/**
 * Zobrazení výkonu baterie pro člověka: + = nabíjení, − = vybíjení.
 * GoodWe (pbattery1) používá opačně: záporné = nabíjení, kladné = vybíjení — viz BATTERY_GOODWE_SIGN.
 */
function formatBatteryPowerW(w) {
  if (w == null || Number.isNaN(Number(w))) return "—";
  const raw = Number(w);
  const display = BATTERY_GOODWE_SIGN ? -raw : raw;
  return formatPowerW(display);
}

/** Barva podle SOC: 0 % červená → 100 % zelená (stejná logika pro sloupec i %). */
function batterySocColor(socPct) {
  const t = Math.max(0, Math.min(100, Number(socPct) || 0)) / 100;
  const h = Math.round(t * 120);
  return `hsl(${h}, 82%, 46%)`;
}

function updateBatterySocUi(socPct, batteryModeLabel) {
  const fill = $("batSocBarFill");
  const sub = $("valBatSoc");
  if (!fill || !sub) return;

  const trackInnerPx = 52;

  if (socPct == null || Number.isNaN(Number(socPct))) {
    fill.style.height = "0";
    fill.style.minHeight = "0";
    fill.style.background = "var(--muted)";
    fill.classList.remove("bat-soc-bar__fill--pulse");
    sub.textContent = "—";
    sub.style.color = "";
    return;
  }

  const soc = Math.max(0, Math.min(100, Number(socPct)));
  const color = batterySocColor(soc);
  const hPx = Math.max(3, (soc / 100) * trackInnerPx);
  fill.style.height = `${hPx}px`;
  fill.style.minHeight = "";
  fill.style.background = color;
  sub.textContent = `${Math.round(soc)} %`;
  sub.style.color = color;

  const mode = batteryModeFromLabel(batteryModeLabel);
  fill.classList.toggle("bat-soc-bar__fill--pulse", mode === "charge");
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

/** Denní řada z /api/series-range?range=day (5min bucket průměr výkonu FV). */
let dayPowerSeries = [];

function drawChart() {
  const canvas = $("chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = cssVar("--surface", "#101218");
  ctx.fillRect(0, 0, w, h);

  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const dayStart = d0.getTime();
  const MS_DAY = 24 * 60 * 60 * 1000;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const pts = (dayPowerSeries || []).filter(
    (p) => p && p.t != null && p.solar_w != null && !Number.isNaN(Number(p.solar_w))
  );
  const vals = pts.map((p) => Number(p.solar_w));

  if (!pts.length) {
    ctx.fillStyle = cssVar("--muted", "#8b93a5");
    ctx.font = "14px DM Sans, sans-serif";
    ctx.fillText("Zatím žádná historie za dnešek — po pár 5min vzorcích se křivka doplní.", padL, h / 2);
    return;
  }

  const maxW = Math.max(100, ...vals) * 1.05;
  const accent = cssVar("--accent", "#3dff7a");
  ctx.strokeStyle = `${accent}44`;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  const xAt = (t) => padL + ((Number(t) - dayStart) / MS_DAY) * innerW;

  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    const x = xAt(p.t);
    if (x < padL - 1 || x > w - padR + 1) continue;
    const y = padT + innerH * (1 - Number(p.solar_w) / maxW);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  if (pts.length === 1) {
    const p = pts[0];
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(xAt(p.t), padT + innerH * (1 - Number(p.solar_w) / maxW), 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = cssVar("--muted", "#8b93a5");
  ctx.font = "10px DM Sans, sans-serif";
  ctx.textAlign = "center";
  for (const hr of [0, 6, 12, 18, 24]) {
    const t = dayStart + hr * 60 * 60 * 1000;
    const x = hr === 24 ? padL + innerW : xAt(t);
    ctx.fillText(hr === 24 ? "24:00" : `${String(hr).padStart(2, "0")}:00`, x, h - 8);
  }
  ctx.textAlign = "left";

  ctx.fillStyle = cssVar("--muted", "#8b93a5");
  ctx.font = "11px DM Sans, sans-serif";
  ctx.fillText(`max ${(maxW / 1000).toFixed(2)} kW`, padL, 14);
}

/** Souhrn dat z LAN webu (A-ZROUTER — bojler) pro řádek pod živými daty. */
function formatLanWebSummary(lan) {
  if (!lan) return null;
  if (lan.ok === false) {
    return lan.error ? `LAN: ${String(lan.error)}` : "LAN: chyba";
  }
  const d = lan.data;
  if (d == null) return "LAN: bez dat";
  if (typeof d !== "object") return `LAN: ${String(d)}`;
  if (d.extract_error) return `LAN: extrakce — ${d.extract_error}`;

  const parts = [];
  if (d.boiler_water_temp_c != null) {
    let s = `voda ${d.boiler_water_temp_c} °C`;
    if (d.boiler_target_temp_c != null) s += ` (cíl ${d.boiler_target_temp_c} °C)`;
    parts.push(s);
  }
  if (d.boiler_status_active === true) parts.push("stav aktivní");
  else if (d.boiler_status_active === false) parts.push("stav neaktivní");
  if (d.boiler_switch_on === true) parts.push("ohřev zapnuto");
  else if (d.boiler_switch_on === false) parts.push("ohřev vypnuto");
  if (d.system_online === true) parts.push("systém online");

  if (parts.length) return `Bojler (LAN): ${parts.join(" · ")}`;
  if (d.page_text) return `LAN (ladění): ${String(d.page_text).slice(0, 240)}…`;
  return `LAN: ${JSON.stringify(d).slice(0, 420)}`;
}

async function loadDayPowerChart() {
  try {
    const r = await apiFetch("/api/series-range?range=day");
    const text = await r.text();
    const j = JSON.parse(text);
    if (!r.ok) return;
    dayPowerSeries = Array.isArray(j.series) ? j.series : [];
    drawChart();
  } catch {
    /* ignore */
  }
}

/** Má smysl ukazovat „Živá data“, pokud přišla měření ze střídače (nezávisle na LAN / Playwright). */
function hasUsableInverterPayload(p) {
  if (!p || typeof p !== "object") return false;
  if (p.normalized && typeof p.normalized === "object" && Object.keys(p.normalized).length)
    return true;
  if (p.sensors && typeof p.sensors === "object" && Object.keys(p.sensors).length) return true;
  if (p.model_name) return true;
  return false;
}

function applyPayload(msg) {
  const payload = msg.payload || msg;
  const flagOk = msg.ok !== false && payload.ok !== false;
  const ok = flagOk || hasUsableInverterPayload(payload);
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
  applyLoadLabelStyle($("valLoad"), n.load_w);
  $("valGrid").textContent = formatPowerW(n.grid_w);
  applyGridLabelStyle($("valGrid"), n.grid_w);
  $("valBat").textContent = formatBatteryPowerW(n.battery_w);
  lastBatterySoc = n.battery_soc_pct;
  lastBatteryModeLabel = s.battery_mode_label ?? s.battery_mode ?? s.battery_work_mode ?? null;
  updateBatterySocUi(n.battery_soc_pct, lastBatteryModeLabel);
  updateHouseImages(lastBatterySoc);
  updatePvInverterFlow(n.solar_w);
  updateBatteryInverterFlow(
    n.battery_w,
    s.battery_mode_label ?? s.battery_mode ?? s.battery_work_mode
  );
  updateLoadInverterFlow(n.load_w);
  updateGridInverterFlow(n.grid_w);

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

  updateBoilerCard(payload, s);

  if (ok && payload.model_name) {
    $("modelLine").textContent = `${payload.model_name}${
      payload.serial_number ? " · " + String(payload.serial_number).slice(0, 12) : ""
    }`;
  }

  const lanEl = $("lanWebLine");
  if (lanEl) {
    const lan = payload.lan_web;
    if (!lan) {
      lanEl.hidden = true;
      lanEl.textContent = "";
      lanEl.classList.remove("err");
    } else {
      lanEl.hidden = false;
      lanEl.classList.toggle("err", lan.ok === false);
      lanEl.textContent = formatLanWebSummary(lan) || "LAN: bez dat";
    }
  }

}

async function loadStats() {
  try {
    const r = await apiFetch(`/api/stats?range=day`);
    const j = await r.json();
    if (j.productionKwh != null) $("kpiProd").textContent = formatKwh(j.productionKwh);
    if (j.consumptionKwh != null) $("kpiCons").textContent = formatKwh(j.consumptionKwh);
    if ((j.estimatedIncomeCzk ?? j.estimatedIncomeEur) != null)
      $("kpiIncome").textContent = formatCzk(j.estimatedIncomeCzk ?? j.estimatedIncomeEur);
    const exportBtn = $("exportXlsBtn");
    if (exportBtn) exportBtn.href = apiUrl(`/api/export/xls?range=day`);
  } catch {
    /* ignore */
  }
}

function connectWs() {
  const ws = new WebSocket(apiWsUrl());

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
updatePvInverterFlow(0);
updateBatteryInverterFlow(0, null);
updateLoadInverterFlow(0);
updateGridInverterFlow(0);
initLogout();
initDraggableLiveBlocks();

apiFetch("/api/live")
  .then((r) => r.json())
  .then((j) => {
    if (j.ok !== false && j.normalized) applyPayload({ ok: true, ts: j.ts, payload: j });
  })
  .catch(() => {});

loadStats();
loadDayPowerChart();
setInterval(loadDayPowerChart, 60 * 1000);
connectWs();

