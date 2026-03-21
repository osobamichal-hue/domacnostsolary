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
    range: preset,
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

module.exports = {
  openDb,
  insertReading,
  latestReading,
  recentSeries,
  statsForRange,
  statsByPreset,
  rowsForRange,
};
