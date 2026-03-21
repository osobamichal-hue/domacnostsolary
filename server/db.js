const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

function openDb(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, "goodwe.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
  `);
  return db;
}

function insertReading(db, ok, payloadObj) {
  const stmt = db.prepare(
    "INSERT INTO readings (ts, ok, payload) VALUES (?, ?, ?)"
  );
  stmt.run(Date.now(), ok ? 1 : 0, JSON.stringify(payloadObj));
}

function latestReading(db) {
  const row = db
    .prepare(
      "SELECT ts, ok, payload FROM readings ORDER BY id DESC LIMIT 1"
    )
    .get();
  if (!row) return null;
  return {
    ts: row.ts,
    ok: row.ok === 1,
    payload: JSON.parse(row.payload),
  };
}

/** Posledních N záznamů pro graf (čas v ms, hodnoty z normalized) */
function recentSeries(db, limit = 360) {
  const rows = db
    .prepare(
      `SELECT ts, payload FROM readings WHERE ok = 1 ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
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

function statsForRange(db, fromTs, toTs) {
  const rows = db
    .prepare(
      `SELECT payload FROM readings WHERE ok = 1 AND ts >= ? AND ts <= ? ORDER BY ts ASC`
    )
    .all(fromTs, toTs);
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

function statsByPreset(db, preset, nowTs = Date.now()) {
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

  const rows = db
    .prepare(
      `SELECT ts, payload FROM readings WHERE ok = 1 AND ts >= ? AND ts <= ? ORDER BY ts ASC`
    )
    .all(fromTs, nowTs);

  const parsed = rows
    .map((r) => {
      try {
        const p = JSON.parse(r.payload);
        return { ts: r.ts, n: p.normalized || {} };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!parsed.length) {
    return {
      range: preset,
      samples: 0,
      productionKwh: null,
      consumptionKwh: null,
    };
  }

  const first = parsed[0].n;
  const last = parsed[parsed.length - 1].n;

  let productionKwh = null;
  let consumptionKwh = null;

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

  return {
    range: preset,
    samples: parsed.length,
    productionKwh,
    consumptionKwh,
  };
}

function rowsForRange(db, fromTs, toTs, limit = 100000) {
  const rows = db
    .prepare(
      `SELECT ts, ok, payload FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT ?`
    )
    .all(fromTs, toTs, limit);

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
      e_total_kwh: n.e_total_kwh ?? null,
      e_load_total_kwh: n.e_load_total_kwh ?? null,
      payload_json: JSON.stringify(payload),
    };
  });
}

module.exports = {
  openDb,
  insertReading,
  latestReading,
  recentSeries,
  statsForRange,
  statsByPreset,
  rowsForRange,
};
