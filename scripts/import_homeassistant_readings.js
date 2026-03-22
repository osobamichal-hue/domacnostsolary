#!/usr/bin/env node
/**
 * Import historických měření z Home Assistant (home-assistant_v2.db) do HomeAPP tabulky readings.
 *
 * Používá tabulku statistics (agregace ~5 min) a mapuje entity GoodWe na payload.normalized.
 *
 * Předpoklady:
 *   1) Rozbalit DB: tar -xf HomeAssist/homeassistant.tar.gz -C scripts/ha_import data/home-assistant_v2.db
 *   2) Nastavit .env (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) jako u serveru.
 *
 * Spuštění:
 *   node scripts/import_homeassistant_readings.js --dry-run
 *   node scripts/import_homeassistant_readings.js --since-years 3
 *   node scripts/import_homeassistant_readings.js --since-years 3 --clean-import
 */

"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");
const Database = require("better-sqlite3");

const DEFAULT_HA_DB = path.join(__dirname, "ha_import", "data", "home-assistant_v2.db");

/** statistic_id → klíč pro sloučení řádků */
const META_ALIASES = [
  ["sensor.pv_power", "pv"],
  ["sensor.battery_power", "bat"],
  ["sensor.house_consumption", "load"],
  ["sensor.active_power_total", "grid"],
  ["sensor.battery_state_of_charge", "soc"],
  ["sensor.today_s_pv_generation", "today_pv"],
  ["sensor.today_load", "today_load"],
  ["sensor.today_energy_export", "today_exp"],
  ["sensor.today_energy_import", "today_imp"],
  ["sensor.total_pv_generation", "total_pv"],
  ["sensor.total_load", "total_load"],
  ["sensor.total_energy_export", "total_exp"],
  ["sensor.total_energy_import", "total_imp"],
];

function parseArgs(argv) {
  const out = {
    dryRun: false,
    sinceYears: 3,
    cleanImport: false,
    haDb: process.env.HA_SQLITE_PATH || DEFAULT_HA_DB,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--clean-import") out.cleanImport = true;
    else if (a === "--since-years" && argv[i + 1]) out.sinceYears = Number(argv[++i]);
    else if (a === "--ha-db" && argv[i + 1]) out.haDb = argv[++i];
  }
  return out;
}

function resolveMetadataMap(db) {
  const metaIds = {};
  const stmt = db.prepare("SELECT id FROM statistics_meta WHERE statistic_id = ?");
  for (const [statisticId, alias] of META_ALIASES) {
    const row = stmt.get(statisticId);
    if (row) metaIds[alias] = row.id;
    else process.stderr.write(`[import] Chybí entita v HA DB: ${statisticId}\n`);
  }
  return metaIds;
}

function loadStatisticsRows(db, metaIds, fromTsSec, toTsSec) {
  const ids = Object.values(metaIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const sql = `
    SELECT start_ts, metadata_id, mean, state, sum
    FROM statistics
    WHERE metadata_id IN (${placeholders})
      AND start_ts >= ? AND start_ts <= ?
    ORDER BY start_ts ASC
  `;
  return db.prepare(sql).all(...ids, fromTsSec, toTsSec);
}

function groupByStartTs(rows, metaIds) {
  const idToAlias = {};
  for (const [statisticId, alias] of META_ALIASES) {
    const id = metaIds[alias];
    if (id != null) idToAlias[id] = alias;
  }
  /** @type {Map<number, Record<string, { mean: number|null, state: number|null, sum: number|null }>>} */
  const byTs = new Map();
  for (const r of rows) {
    const alias = idToAlias[r.metadata_id];
    if (!alias) continue;
    if (!byTs.has(r.start_ts)) byTs.set(r.start_ts, {});
    const g = byTs.get(r.start_ts);
    g[alias] = {
      mean: r.mean != null ? Number(r.mean) : null,
      state: r.state != null ? Number(r.state) : null,
      sum: r.sum != null ? Number(r.sum) : null,
    };
  }
  return byTs;
}

function buildPayload(tsSec, bucket) {
  const tsMs = tsSec * 1000;
  const n = {
    solar_w: bucket.pv?.mean ?? null,
    battery_w: bucket.bat?.mean ?? null,
    load_w: bucket.load?.mean ?? null,
    grid_w: bucket.grid?.mean ?? null,
    battery_soc_pct: bucket.soc?.mean ?? null,
    e_day_kwh: bucket.today_pv?.state ?? null,
    e_load_day_kwh: bucket.today_load?.state ?? null,
    e_day_export_kwh: bucket.today_exp?.state ?? null,
    e_day_import_kwh: bucket.today_imp?.state ?? null,
    e_total_kwh: bucket.total_pv?.state ?? null,
    e_load_total_kwh: bucket.total_load?.state ?? null,
    e_total_export_kwh: bucket.total_exp?.state ?? null,
    e_total_import_kwh: bucket.total_imp?.state ?? null,
  };
  return {
    ok: true,
    ts: new Date(tsMs).toISOString(),
    source: "homeassistant_import",
    normalized: n,
    sensors: {},
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.haDb)) {
    console.error(
      `Soubor HA databáze neexistuje: ${args.haDb}\n` +
        `Rozbal: tar -xf HomeAssist/homeassistant.tar.gz -C scripts/ha_import data/home-assistant_v2.db`
    );
    process.exit(1);
  }

  const ha = new Database(args.haDb, { readonly: true });
  const metaIds = resolveMetadataMap(ha);
  const need = ["pv", "bat", "load", "grid"];
  for (const k of need) {
    if (metaIds[k] == null) {
      console.error(`Chybí povinná metadata_id pro ${k}. Zkontroluj entity v HA.`);
      process.exit(1);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - Math.ceil(args.sinceYears * 365.25 * 24 * 3600);

  const rows = loadStatisticsRows(ha, metaIds, fromSec, nowSec);
  const byTs = groupByStartTs(rows, metaIds);
  ha.close();

  const timestamps = [...byTs.keys()].sort((a, b) => a - b);
  console.log(
    `[import] Období od ${new Date(fromSec * 1000).toISOString()} · časových řezů: ${timestamps.length} · řádků statistics: ${rows.length}`
  );

  if (timestamps.length === 0) {
    console.warn("[import] Žádná data v zadaném rozsahu — zkontroluj --since-years a HA databázi.");
    process.exit(0);
  }

  if (args.dryRun) {
    console.log("[import] Dry-run — zápis do MySQL se neprovedl.");
    process.exit(0);
  }

  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT || 3306);
  const user = process.env.DB_USER || "root";
  const password = process.env.DB_PASSWORD || "mysql";
  const database = process.env.DB_NAME || "homeapp";

  const pool = await mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 5,
  });

  if (args.cleanImport) {
    const [res] = await pool.query(
      `DELETE FROM readings WHERE JSON_UNQUOTE(JSON_EXTRACT(payload, '$.source')) = ?`,
      ["homeassistant_import"]
    );
    console.log(`[import] --clean-import: smazáno řádků ${res.affectedRows ?? 0}`);
  }

  const insertSql = "INSERT INTO readings (ts, ok, payload) VALUES (?, ?, ?)";
  let inserted = 0;
  const batchSize = 400;
  let batch = [];

  for (const tsSec of timestamps) {
    const bucket = byTs.get(tsSec);
    const payload = buildPayload(tsSec, bucket);
    const tsMs = tsSec * 1000;
    batch.push([tsMs, 1, JSON.stringify(payload)]);
    if (batch.length >= batchSize) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const row of batch) await conn.query(insertSql, row);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      inserted += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const row of batch) await conn.query(insertSql, row);
      await conn.commit();
    } finally {
      conn.release();
    }
    inserted += batch.length;
  }

  await pool.end();
  console.log(`[import] Vloženo záznamů: ${inserted}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
