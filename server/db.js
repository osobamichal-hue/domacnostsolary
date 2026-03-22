const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");

async function migrateSqliteIfNeeded(pool, sqlitePath) {
  if (!fs.existsSync(sqlitePath)) return;
  const [[countRow]] = await pool.query("SELECT COUNT(*) AS c FROM readings");
  if (Number(countRow.c || 0) > 0) return;

  let SQLite;
  try {
    SQLite = require("better-sqlite3");
  } catch {
    return;
  }
  const sqlite = new SQLite(sqlitePath, { readonly: true });
  const stmt = sqlite.prepare("SELECT id, ts, ok, payload FROM readings ORDER BY id ASC");
  const iter = stmt.iterate();

  const batch = [];
  const flush = async () => {
    if (!batch.length) return;
    for (const row of batch) {
      await pool.query(
        "INSERT INTO readings (id, ts, ok, payload) VALUES (?, ?, ?, ?)",
        row
      );
    }
    batch.length = 0;
  };

  for (const row of iter) {
    batch.push([row.id, row.ts, row.ok ? 1 : 0, row.payload]);
    if (batch.length >= 500) await flush();
  }
  await flush();

  const [[maxRow]] = await pool.query("SELECT MAX(id) AS m FROM readings");
  const nextId = Number(maxRow.m || 0) + 1;
  await pool.query(`ALTER TABLE readings AUTO_INCREMENT = ${nextId}`);
  sqlite.close();
}

async function openDb(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD || "mysql";
  const database = process.env.DB_NAME || "homeapp";

  const admin = await mysql.createConnection({ host, port, user, password });
  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await admin.end();

  const pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: false,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ts BIGINT NOT NULL,
      ok TINYINT(1) NOT NULL,
      payload LONGTEXT NOT NULL,
      INDEX idx_readings_ts (ts),
      INDEX idx_readings_ok_ts (ok, ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_sessions_token (token_hash),
      INDEX idx_user_sessions_user (user_id),
      INDEX idx_user_sessions_expires (expires_at),
      CONSTRAINT fk_user_sessions_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const sqlitePath = path.join(dataDir, "goodwe.sqlite");
  await migrateSqliteIfNeeded(pool, sqlitePath);
  return pool;
}

async function insertReading(db, ok, payloadObj) {
  await db.query(
    "INSERT INTO readings (ts, ok, payload) VALUES (?, ?, ?)",
    [Date.now(), ok ? 1 : 0, JSON.stringify(payloadObj)]
  );
}

async function latestReading(db) {
  const [rows] = await db.query(
    "SELECT ts, ok, payload FROM readings ORDER BY id DESC LIMIT 1"
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ts: Number(row.ts),
    ok: Number(row.ok) === 1,
    payload: JSON.parse(row.payload),
  };
}

/** Posledních N záznamů pro graf (čas v ms, hodnoty z normalized) */
async function recentSeries(db, limit = 360) {
  const [rows] = await db.query(
    "SELECT ts, payload FROM readings WHERE ok = 1 ORDER BY id DESC LIMIT ?",
    [limit]
  );
  return rows
    .map((r) => {
      let p;
      try {
        p = JSON.parse(r.payload);
      } catch {
        return null;
      }
      const n = p.normalized || {};
      return {
        t: r.ts,
        solar_w: n.solar_w,
        load_w: n.load_w,
        grid_w: n.grid_w,
        battery_w: n.battery_w,
        battery_soc_pct: n.battery_soc_pct,
      };
    })
    .filter(Boolean)
    .reverse();
}

async function statsForRange(db, fromTs, toTs) {
  const [rows] = await db.query(
    "SELECT payload FROM readings WHERE ok = 1 AND ts >= ? AND ts <= ? ORDER BY ts ASC",
    [fromTs, toTs]
  );
  if (rows.length === 0) {
    return { samples: 0, last_e_day_kwh: null, last_e_load_day_kwh: null };
  }
  let last;
  for (const r of rows) {
    try {
      last = JSON.parse(r.payload);
    } catch {
      continue;
    }
  }
  const n = last?.normalized || {};
  return {
    samples: rows.length,
    last_e_day_kwh: n.e_day_kwh ?? null,
    last_e_load_day_kwh: n.e_load_day_kwh ?? null,
  };
}

/** MySQL může vracet BIGINT jako string/BigInt — Date musí z ms čísla, ne z řetězce číslic. */
function toMs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === "bigint") return Number(ts);
  const n = Number(ts);
  return Number.isFinite(n) ? n : NaN;
}

/** Lokální kalendářní den (server TZ) — pro součty denních čítačů. */
function dayKeyFromTs(ts) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Denní / celkové energie bývají v normalized i v sensors (GoodWe různé názvy polí).
 */
function mergeNormalizedFromPayload(payload) {
  const n0 = payload && payload.normalized && typeof payload.normalized === "object"
    ? { ...payload.normalized }
    : {};
  const s = payload && payload.sensors && typeof payload.sensors === "object" ? payload.sensors : {};

  function firstNum(keys) {
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(n0, k)) {
        const v = numOrNull(n0[k]);
        if (v != null) return v;
      }
    }
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(s, k)) {
        const v = numOrNull(s[k]);
        if (v != null) return v;
      }
    }
    return null;
  }

  const fill = (canonical, ...aliases) => {
    const keys = [canonical, ...aliases];
    if (numOrNull(n0[canonical]) != null) return;
    const v = firstNum(keys);
    if (v != null) n0[canonical] = v;
  };

  fill("e_day_kwh", "e_day");
  fill("e_load_day_kwh", "e_load_day");
  fill("e_day_export_kwh", "e_day_exp");
  fill("e_day_import_kwh", "e_day_imp");
  fill("e_total_kwh", "e_total");
  fill("e_load_total_kwh", "e_load_total");
  fill("e_total_export_kwh", "e_total_exp");
  fill("e_total_import_kwh", "e_total_imp");

  return n0;
}

/**
 * Pro každý kalendářní den vezme maximum hodnoty (denní čítač roste během dne).
 * Sečte přes dny v rozsahu – vhodné pro měsíc/rok i když chybí životní energie (e_total).
 */
function sumDailyMaxByField(parsed, fieldName) {
  const byDay = new Map();
  for (const row of parsed) {
    const raw = row.n[fieldName];
    if (raw == null || Number.isNaN(Number(raw))) continue;
    const num = Number(raw);
    const key = dayKeyFromTs(row.ts);
    if (key == null) continue;
    const prev = byDay.get(key);
    if (prev == null || num > prev) byDay.set(key, num);
  }
  if (byDay.size === 0) return null;
  let sum = 0;
  for (const x of byDay.values()) sum += x;
  return sum;
}

function parsePayloadRowsToParsed(rows) {
  return rows
    .map((r) => {
      try {
        const p = JSON.parse(r.payload);
        const ts = toMs(r.ts);
        if (!Number.isFinite(ts)) return null;
        const n = mergeNormalizedFromPayload(p);
        return { ts, n };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {{ ts: number, n: object }[]} parsed — seřazeno podle ts
 * @param {'day'|'month'|'year'} preset
 */
function computeEnergyStatsFromParsed(parsed, preset) {
  if (!parsed.length) {
    return {
      samples: 0,
      productionKwh: null,
      consumptionKwh: null,
      gridExportKwh: null,
      gridImportKwh: null,
      selfConsumptionKwh: null,
      selfSufficiencyPct: null,
      gridDependencyPct: null,
    };
  }

  const first = parsed[0].n;
  const last = parsed[parsed.length - 1].n;

  let productionKwh = null;
  let consumptionKwh = null;
  let gridExportKwh = null;
  let gridImportKwh = null;

  if (preset === "day" && last.e_day_kwh != null) {
    productionKwh = last.e_day_kwh;
  } else if (last.e_total_kwh != null && first.e_total_kwh != null) {
    productionKwh = Math.max(0, Number(last.e_total_kwh) - Number(first.e_total_kwh));
  }

  if (preset === "day" && last.e_load_day_kwh != null) {
    consumptionKwh = last.e_load_day_kwh;
  } else if (last.e_load_total_kwh != null && first.e_load_total_kwh != null) {
    consumptionKwh = Math.max(
      0,
      Number(last.e_load_total_kwh) - Number(first.e_load_total_kwh)
    );
  }

  if (preset === "day" && last.e_day_export_kwh != null) {
    gridExportKwh = Math.max(0, Number(last.e_day_export_kwh));
  } else if (
    last.e_total_export_kwh != null &&
    first.e_total_export_kwh != null
  ) {
    gridExportKwh = Math.max(
      0,
      Number(last.e_total_export_kwh) - Number(first.e_total_export_kwh)
    );
  }

  if (preset === "day" && last.e_day_import_kwh != null) {
    gridImportKwh = Math.max(0, Number(last.e_day_import_kwh));
  } else if (
    last.e_total_import_kwh != null &&
    first.e_total_import_kwh != null
  ) {
    gridImportKwh = Math.max(
      0,
      Number(last.e_total_import_kwh) - Number(first.e_total_import_kwh)
    );
  }

  if (productionKwh == null || Number.isNaN(Number(productionKwh))) {
    const s = sumDailyMaxByField(parsed, "e_day_kwh");
    if (s != null) productionKwh = s;
  }
  if (consumptionKwh == null || Number.isNaN(Number(consumptionKwh))) {
    const s = sumDailyMaxByField(parsed, "e_load_day_kwh");
    if (s != null) consumptionKwh = s;
  }
  if (gridExportKwh == null || Number.isNaN(Number(gridExportKwh))) {
    const s = sumDailyMaxByField(parsed, "e_day_export_kwh");
    if (s != null) gridExportKwh = s;
  }
  if (gridImportKwh == null || Number.isNaN(Number(gridImportKwh))) {
    const s = sumDailyMaxByField(parsed, "e_day_import_kwh");
    if (s != null) gridImportKwh = s;
  }

  let selfConsumptionKwh = null;
  if (productionKwh != null && gridExportKwh != null) {
    selfConsumptionKwh = Math.max(0, Number(productionKwh) - Number(gridExportKwh));
  } else if (consumptionKwh != null && gridImportKwh != null) {
    selfConsumptionKwh = Math.max(0, Number(consumptionKwh) - Number(gridImportKwh));
  }

  let selfSufficiencyPct = null;
  let gridDependencyPct = null;
  if (consumptionKwh != null && Number(consumptionKwh) > 0) {
    if (selfConsumptionKwh != null) {
      selfSufficiencyPct = Math.max(
        0,
        Math.min(100, (Number(selfConsumptionKwh) / Number(consumptionKwh)) * 100)
      );
    }
    if (gridImportKwh != null) {
      gridDependencyPct = Math.max(
        0,
        Math.min(100, (Number(gridImportKwh) / Number(consumptionKwh)) * 100)
      );
    }
  }

  return {
    samples: parsed.length,
    productionKwh,
    consumptionKwh,
    gridExportKwh,
    gridImportKwh,
    selfConsumptionKwh,
    selfSufficiencyPct,
    gridDependencyPct,
  };
}

async function statsByPreset(db, preset, nowTs = Date.now()) {
  const d = new Date(nowTs);
  let fromTs = 0;
  if (preset === "day") {
    d.setHours(0, 0, 0, 0);
    fromTs = d.getTime();
  } else if (preset === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    fromTs = d.getTime();
  } else if (preset === "year") {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    fromTs = d.getTime();
  } else {
    throw new Error(`Unknown preset ${preset}`);
  }

  const [rows] = await db.query(
    "SELECT ts, payload FROM readings WHERE ok = 1 AND ts >= ? AND ts <= ? ORDER BY ts ASC",
    [fromTs, nowTs]
  );

  const parsed = parsePayloadRowsToParsed(rows);
  if (!parsed.length) {
    return {
      range: preset,
      samples: 0,
      productionKwh: null,
      consumptionKwh: null,
      gridExportKwh: null,
      gridImportKwh: null,
      selfConsumptionKwh: null,
      selfSufficiencyPct: null,
      gridDependencyPct: null,
    };
  }

  const stats = computeEnergyStatsFromParsed(parsed, preset);
  return {
    range: preset,
    ...stats,
  };
}

function monthKeyFromTs(ts) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function yearKeyFromTs(ts) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return null;
  return String(new Date(ms).getFullYear());
}

function groupParsedBy(parsed, keyFn) {
  const m = new Map();
  for (const row of parsed) {
    const key = keyFn(row.ts);
    if (key == null) continue;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(row);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.ts - b.ts);
  return m;
}

async function loadParsedOkReadings(db, fromTs, toTs, maxRows = 800000) {
  const [rows] = await db.query(
    "SELECT ts, payload FROM readings WHERE ok = 1 AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?",
    [fromTs, toTs, maxRows]
  );
  return parsePayloadRowsToParsed(rows);
}

/** Souhrn od nejstaršího platného vzorku do teď (stejná delta logika jako u „rok“). */
async function statsAllTime(db, nowTs = Date.now()) {
  const [boundRows] = await db.query(
    "SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM readings WHERE ok = 1"
  );
  const bounds = boundRows[0];
  const minTs = bounds?.mn != null ? Number(bounds.mn) : null;
  const maxTs = bounds?.mx != null ? Number(bounds.mx) : null;
  const empty = {
    samples: 0,
    productionKwh: null,
    consumptionKwh: null,
    gridExportKwh: null,
    gridImportKwh: null,
    selfConsumptionKwh: null,
    selfSufficiencyPct: null,
    gridDependencyPct: null,
    firstDataTs: null,
    lastDataTs: null,
  };
  if (minTs == null || maxTs == null) {
    return empty;
  }
  const toTs = Math.min(nowTs, maxTs);
  const parsed = await loadParsedOkReadings(db, minTs, toTs);
  if (!parsed.length) {
    return { ...empty, firstDataTs: minTs, lastDataTs: maxTs };
  }
  const st = computeEnergyStatsFromParsed(parsed, "year");
  return {
    ...st,
    firstDataTs: minTs,
    lastDataTs: maxTs,
  };
}

/** Rychlé přehledy: dnešek, aktuální měsíc, aktuální rok, celé období od prvních dat. */
async function statsSnapshot(db, nowTs = Date.now()) {
  const day = await statsByPreset(db, "day", nowTs);
  const month = await statsByPreset(db, "month", nowTs);
  const year = await statsByPreset(db, "year", nowTs);
  const allTime = await statsAllTime(db, nowTs);
  return { day, month, year, allTime, nowTs };
}

/**
 * Rozpad podle kalendáře.
 * @param {'years'|'months'|'days'} granularity
 * @param {number} [year] pro months/days
 * @param {number} [month] 1–12 pro days
 */
async function statsBreakdown(db, granularity, year, month, nowTs = Date.now()) {
  const [boundRows] = await db.query(
    "SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM readings WHERE ok = 1"
  );
  const bounds = boundRows[0];
  const minTs = bounds?.mn != null ? Number(bounds.mn) : null;
  const maxTs = bounds?.mx != null ? Number(bounds.mx) : null;
  if (minTs == null || maxTs == null) {
    return { granularity, items: [], bounds: null };
  }

  const toTs = Math.min(nowTs, maxTs);

  if (granularity === "years") {
    const parsed = await loadParsedOkReadings(db, minTs, toTs);
    const byYear = groupParsedBy(parsed, yearKeyFromTs);
    const keys = [...byYear.keys()].sort((a, b) => Number(b) - Number(a));
    const items = keys.map((key) => {
      const st = computeEnergyStatsFromParsed(byYear.get(key), "year");
      return {
        key,
        label: key,
        fromTs: byYear.get(key)[0].ts,
        toTs: byYear.get(key)[byYear.get(key).length - 1].ts,
        ...st,
      };
    });
    return { granularity, items, bounds: { minTs, maxTs } };
  }

  if (granularity === "months") {
    const y = Number(year);
    if (!Number.isFinite(y)) throw new Error("Chybí platný year");
    const from = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
    const to = Math.min(new Date(y, 11, 31, 23, 59, 59, 999).getTime(), toTs);
    const parsed = await loadParsedOkReadings(db, from, to);
    const byMonth = groupParsedBy(parsed, monthKeyFromTs);
    const keys = [...byMonth.keys()].sort();
    const monthNames = [
      "Leden",
      "Únor",
      "Březen",
      "Duben",
      "Květen",
      "Červen",
      "Červenec",
      "Srpen",
      "Září",
      "Říjen",
      "Listopad",
      "Prosinec",
    ];
    const items = keys.map((key) => {
      const arr = byMonth.get(key);
      const st = computeEnergyStatsFromParsed(arr, "month");
      const [, mm] = key.split("-");
      const mi = Number(mm) - 1;
      return {
        key,
        label: `${monthNames[mi] || key} ${y}`,
        fromTs: arr[0].ts,
        toTs: arr[arr.length - 1].ts,
        ...st,
      };
    });
    return { granularity, year: y, items, bounds: { minTs, maxTs } };
  }

  if (granularity === "days") {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      throw new Error("Chybí platný year a month (1–12)");
    }
    const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
    const lastDay = new Date(y, m, 0, 23, 59, 59, 999).getTime();
    const to = Math.min(lastDay, toTs);
    const parsed = await loadParsedOkReadings(db, from, to);
    const byDay = groupParsedBy(parsed, dayKeyFromTs);
    const keys = [...byDay.keys()].sort();
    const items = keys.map((key) => {
      const arr = byDay.get(key);
      const st = computeEnergyStatsFromParsed(arr, "day");
      return {
        key,
        label: key,
        fromTs: arr[0].ts,
        toTs: arr[arr.length - 1].ts,
        ...st,
      };
    });
    return { granularity, year: y, month: m, items, bounds: { minTs, maxTs } };
  }

  throw new Error("Neplatná granularita");
}

const MONTH_NAMES_CS = [
  "Leden",
  "Únor",
  "Březen",
  "Duben",
  "Květen",
  "Červen",
  "Červenec",
  "Srpen",
  "Září",
  "Říjen",
  "Listopad",
  "Prosinec",
];

function sumNullableNumbers(arr) {
  let s = 0;
  for (const x of arr) {
    if (x != null && !Number.isNaN(Number(x))) s += Number(x);
  }
  return s;
}

/**
 * Měsíční matice po letech (jako list „Statistiky“ v Excelu): řádky = roky, sloupce = měsíce + celkem.
 */
async function statsMonthlyMatrix(db, nowTs = Date.now()) {
  const [boundRows] = await db.query(
    "SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM readings WHERE ok = 1"
  );
  const minTs = boundRows[0]?.mn != null ? Number(boundRows[0].mn) : null;
  const maxTs = boundRows[0]?.mx != null ? Number(boundRows[0].mx) : null;
  if (minTs == null || maxTs == null) {
    return { monthNames: MONTH_NAMES_CS, rows: [], bounds: null };
  }

  const toTs = Math.min(nowTs, maxTs);
  const yMin = new Date(minTs).getFullYear();
  const yMax = new Date(toTs).getFullYear();
  const rows = [];

  for (let y = yMin; y <= yMax; y++) {
    const from = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
    const to = Math.min(new Date(y, 11, 31, 23, 59, 59, 999).getTime(), toTs);
    const parsed = await loadParsedOkReadings(db, from, to);
    const byMonth = groupParsedBy(parsed, monthKeyFromTs);
    const productionMonths = Array(12).fill(null);
    const consumptionMonths = Array(12).fill(null);
    const gridExportMonths = Array(12).fill(null);
    const gridImportMonths = Array(12).fill(null);

    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const arr = byMonth.get(key);
      if (!arr || !arr.length) continue;
      const st = computeEnergyStatsFromParsed(arr, "month");
      productionMonths[m - 1] = st.productionKwh;
      consumptionMonths[m - 1] = st.consumptionKwh;
      gridExportMonths[m - 1] = st.gridExportKwh;
      gridImportMonths[m - 1] = st.gridImportKwh;
    }

    const byDay = groupParsedBy(parsed, dayKeyFromTs);
    const uniqueDays = byDay.size;

    const totalProduction = sumNullableNumbers(productionMonths);
    const totalConsumption = sumNullableNumbers(consumptionMonths);
    const totalGridExport = sumNullableNumbers(gridExportMonths);
    const totalGridImport = sumNullableNumbers(gridImportMonths);

    rows.push({
      year: y,
      productionMonths,
      consumptionMonths,
      gridExportMonths,
      gridImportMonths,
      totalProduction,
      totalConsumption,
      totalGridExport,
      totalGridImport,
      uniqueDaysInYear: uniqueDays,
      avgDailyProductionKwh: uniqueDays > 0 ? totalProduction / uniqueDays : null,
      avgDailyGridImportKwh: uniqueDays > 0 ? totalGridImport / uniqueDays : null,
    });
  }

  return {
    monthNames: MONTH_NAMES_CS,
    rows,
    bounds: { minTs, maxTs },
  };
}

async function rowsForRange(db, fromTs, toTs, limit = 100000) {
  const [rows] = await db.query(
    "SELECT ts, ok, payload FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?",
    [fromTs, toTs, limit]
  );

  return rows.map((r) => {
    let payload = {};
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = {};
    }
    const n = payload.normalized || {};
    return {
      ts: r.ts,
      ok: r.ok === 1,
      model_name: payload.model_name || null,
      serial_number: payload.serial_number || null,
      solar_w: n.solar_w ?? null,
      load_w: n.load_w ?? null,
      grid_w: n.grid_w ?? null,
      battery_w: n.battery_w ?? null,
      battery_soc_pct: n.battery_soc_pct ?? null,
      e_day_kwh: n.e_day_kwh ?? null,
      e_load_day_kwh: n.e_load_day_kwh ?? null,
      e_day_export_kwh: n.e_day_export_kwh ?? null,
      e_day_import_kwh: n.e_day_import_kwh ?? null,
      e_total_kwh: n.e_total_kwh ?? null,
      e_load_total_kwh: n.e_load_total_kwh ?? null,
      e_total_export_kwh: n.e_total_export_kwh ?? null,
      e_total_import_kwh: n.e_total_import_kwh ?? null,
      payload_json: JSON.stringify(payload),
    };
  });
}

async function createUser(db, username, passwordHash) {
  const [res] = await db.query(
    "INSERT INTO users (username, password_hash) VALUES (?, ?)",
    [username, passwordHash]
  );
  return Number(res.insertId);
}

async function getUserByUsername(db, username) {
  const [rows] = await db.query(
    "SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
  };
}

async function createSession(db, userId, tokenHash, expiresAtMs) {
  await db.query(
    "INSERT INTO user_sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAtMs]
  );
}

async function getSessionWithUserByTokenHash(db, tokenHash) {
  const now = Date.now();
  const [rows] = await db.query(
    `SELECT s.user_id, s.expires_at, u.username
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? LIMIT 1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt < now) {
    await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
    return null;
  }
  return {
    userId: Number(row.user_id),
    username: String(row.username),
    expiresAt,
  };
}

async function deleteSessionByTokenHash(db, tokenHash) {
  await db.query("DELETE FROM user_sessions WHERE token_hash = ?", [tokenHash]);
}

async function pruneExpiredSessions(db) {
  await db.query("DELETE FROM user_sessions WHERE expires_at < ?", [Date.now()]);
}

module.exports = {
  openDb,
  insertReading,
  latestReading,
  recentSeries,
  statsForRange,
  statsByPreset,
  statsSnapshot,
  statsBreakdown,
  statsMonthlyMatrix,
  rowsForRange,
  createUser,
  getUserByUsername,
  createSession,
  getSessionWithUserByTokenHash,
  deleteSessionByTokenHash,
  pruneExpiredSessions,
};
