"use strict";

require("dotenv").config();
const http = require("http");
const path = require("path");
const XLSX = require("xlsx");

const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const {
  openDb,
  insertReading,
  latestReading,
  recentSeries,
  statsByPreset,
  rowsForRange,
} = require("./db");
const { fetchFromInverter } = require("./poller");
const { createConfigStore } = require("./configStore");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "..", "data");

const config = createConfigStore(DATA_DIR);

const app = express();
app.use(cors());
app.use(express.json());

const db = openDb(DATA_DIR);

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

function getFeedIn() {
  return config.get().feedInEurPerKwh;
}

function getRangeBounds(preset, nowTs = Date.now()) {
  const d = new Date(nowTs);
  if (preset === "day") {
    d.setHours(0, 0, 0, 0);
    return { fromTs: d.getTime(), toTs: nowTs };
  }
  if (preset === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return { fromTs: d.getTime(), toTs: nowTs };
  }
  if (preset === "year") {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    return { fromTs: d.getTime(), toTs: nowTs };
  }
  throw new Error("Neplatný rozsah. Použijte day, month, year.");
}

app.get("/api/config", (_req, res) => {
  res.json({ ok: true, ...config.get() });
});

app.put("/api/config", (req, res) => {
  try {
    const updated = config.update(req.body || {});
    restartPolling();
    broadcast({
      type: "config",
      ...updated,
    });
    res.json({ ok: true, ...updated });
  } catch (e) {
    if (e.code === "VALIDATION") {
      return res.status(400).json({ ok: false, error: e.message });
    }
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/health", (_req, res) => {
  const c = config.get();
  res.json({
    ok: true,
    goodweHostConfigured: Boolean(c.goodweHost),
    pollIntervalMs: c.pollIntervalMs,
    port: PORT,
  });
});

app.get("/api/live", (_req, res) => {
  const row = latestReading(db);
  if (!row) {
    return res.json({ ok: false, message: "Zatím žádná data" });
  }
  const fi = getFeedIn();
  const income =
    row.payload?.normalized?.e_day_kwh != null
      ? row.payload.normalized.e_day_kwh * fi
      : null;
  res.json({
    ok: row.ok,
    ts: row.ts,
    feedInEurPerKwh: fi,
    estimatedIncomeEur: income,
    ...row.payload,
  });
});

app.get("/api/series", (req, res) => {
  const limit = Math.min(2000, Math.max(10, Number(req.query.limit) || 360));
  res.json({ series: recentSeries(db, limit) });
});

app.get("/api/series-range", (req, res) => {
  try {
    const range = String(req.query.range || "day").toLowerCase();
    const { fromTs, toTs } = getRangeBounds(range, Date.now());
    const raw = rowsForRange(db, fromTs, toTs, 250000).filter((r) => r.ok);

    let bucketMs = 15 * 60 * 1000;
    if (range === "day") bucketMs = 5 * 60 * 1000;
    if (range === "year") bucketMs = 24 * 60 * 60 * 1000;

    const buckets = new Map();
    for (const r of raw) {
      const b = Math.floor(r.ts / bucketMs) * bucketMs;
      if (!buckets.has(b)) {
        buckets.set(b, {
          t: b,
          count: 0,
          solar_w: 0,
          load_w: 0,
          grid_w: 0,
          battery_w: 0,
          battery_soc_pct: 0,
          socCount: 0,
        });
      }
      const item = buckets.get(b);
      item.count += 1;
      item.solar_w += Number(r.solar_w || 0);
      item.load_w += Number(r.load_w || 0);
      item.grid_w += Number(r.grid_w || 0);
      item.battery_w += Number(r.battery_w || 0);
      if (r.battery_soc_pct != null) {
        item.battery_soc_pct += Number(r.battery_soc_pct);
        item.socCount += 1;
      }
    }

    const series = Array.from(buckets.values())
      .sort((a, b) => a.t - b.t)
      .map((b) => ({
        t: b.t,
        solar_w: b.count ? b.solar_w / b.count : null,
        load_w: b.count ? b.load_w / b.count : null,
        grid_w: b.count ? b.grid_w / b.count : null,
        battery_w: b.count ? b.battery_w / b.count : null,
        battery_soc_pct: b.socCount ? b.battery_soc_pct / b.socCount : null,
      }));

    res.json({ range, bucketMs, series });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/stats", (req, res) => {
  try {
    const range = String(req.query.range || "day").toLowerCase();
    const s = statsByPreset(db, range, Date.now());
    const fi = getFeedIn();
    const income =
      s.productionKwh != null ? Number(s.productionKwh) * fi : null;
    res.json({
      ...s,
      estimatedIncomeEur: income,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/export/xls", (req, res) => {
  try {
    const range = String(req.query.range || "day").toLowerCase();
    const { fromTs, toTs } = getRangeBounds(range, Date.now());
    const rows = rowsForRange(db, fromTs, toTs, 200000).map((r) => ({
      timestamp_iso: new Date(r.ts).toISOString(),
      ok: r.ok,
      model_name: r.model_name,
      serial_number: r.serial_number,
      solar_w: r.solar_w,
      load_w: r.load_w,
      grid_w: r.grid_w,
      battery_w: r.battery_w,
      battery_soc_pct: r.battery_soc_pct,
      e_day_kwh: r.e_day_kwh,
      e_load_day_kwh: r.e_load_day_kwh,
      e_total_kwh: r.e_total_kwh,
      e_load_total_kwh: r.e_load_total_kwh,
      payload_json: r.payload_json,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "goodwe_data");
    const fileBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const datePart = new Date().toISOString().slice(0, 10);
    const filename = `goodwe_${range}_${datePart}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(fileBuffer);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

let pollTimer = null;

async function pollOnce() {
  const c = config.get();
  if (!c.goodweHost) {
    broadcast({
      type: "error",
      message: "Nastavte IP adresu střídače v nastavení.",
    });
    return;
  }
  try {
    const payload = await fetchFromInverter(c.pythonExe, c.goodweHost);
    const ok = Boolean(payload.ok);
    insertReading(db, ok, payload);
    broadcast({
      type: "reading",
      ok,
      ts: Date.now(),
      feedInEurPerKwh: c.feedInEurPerKwh,
      payload,
    });
  } catch (e) {
    const fail = {
      ok: false,
      error: String(e.message || e),
      ts: new Date().toISOString(),
    };
    insertReading(db, false, fail);
    broadcast({
      type: "reading",
      ok: false,
      ts: Date.now(),
      feedInEurPerKwh: c.feedInEurPerKwh,
      payload: fail,
    });
  }
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const ms = config.get().pollIntervalMs;
  pollOnce();
  pollTimer = setInterval(pollOnce, ms);
}

wss.on("connection", (ws) => {
  const c = config.get();
  ws.send(JSON.stringify({ type: "config", ...c }));
  const row = latestReading(db);
  if (row) {
    ws.send(
      JSON.stringify({
        type: "reading",
        ok: row.ok,
        ts: row.ts,
        feedInEurPerKwh: c.feedInEurPerKwh,
        payload: row.payload,
      })
    );
  }
});

server.listen(PORT, () => {
  console.log(`HomeAPP GoodWe dashboard: http://localhost:${PORT}`);
  restartPolling();
});
