"use strict";

require("dotenv").config();
const http = require("http");
const path = require("path");
const crypto = require("crypto");
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
} = require("./db");
const { fetchFromInverter, fetchFromLanWeb } = require("./poller");
const { createConfigStore } = require("./configStore");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "..", "data");

const config = createConfigStore(DATA_DIR);

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());

const dbPromise = openDb(DATA_DIR);

const publicDir = path.join(__dirname, "..", "public");
const SESSION_COOKIE = "homeapp_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1];
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(password, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(
      token
    )}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

async function authenticateRequest(req, res, next) {
  try {
    const url = String(req.path || req.url || "");
    const isAuthMe = url === "/api/auth/me";
    const publicPath =
      url === "/login" ||
      url === "/login.html" ||
      url === "/login.js" ||
      url === "/styles.css" ||
      url.startsWith("/pict/") ||
      (url.startsWith("/api/auth/") && !isAuthMe) ||
      url === "/api/health";
    if (publicPath) return next();

    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return rejectAuth(req, res);
    const db = await dbPromise;
    const session = await getSessionWithUserByTokenHash(db, hashToken(token));
    if (!session) return rejectAuth(req, res);
    req.authUser = { id: session.userId, username: session.username };
    return next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

function rejectAuth(req, res) {
  if (String(req.path || "").startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Nejste přihlášen." });
  }
  return res.redirect("/login.html");
}

app.use(authenticateRequest);
app.use(express.static(publicDir));
app.get("/login", (_req, res) => res.sendFile(path.join(publicDir, "login.html")));

app.get("/api/auth/me", async (req, res) => {
  if (!req.authUser) return res.status(401).json({ ok: false, error: "Nejste přihlášen." });
  res.json({ ok: true, user: { id: req.authUser.id, username: req.authUser.username } });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
      return res
        .status(400)
        .json({ ok: false, error: "Uživatel musí mít 3-40 znaků: písmena, čísla, ., _, -" });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: "Heslo musí mít alespoň 8 znaků." });
    }
    const db = await dbPromise;
    const exists = await getUserByUsername(db, username);
    if (exists) {
      return res.status(409).json({ ok: false, error: "Uživatel již existuje." });
    }
    const userId = await createUser(db, username, hashPassword(password));
    const token = crypto.randomBytes(32).toString("hex");
    await createSession(db, userId, hashToken(token), Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: userId, username } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const db = await dbPromise;
    const user = await getUserByUsername(db, username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ ok: false, error: "Neplatné přihlašovací údaje." });
    }
    const token = crypto.randomBytes(32).toString("hex");
    await createSession(db, user.id, hashToken(token), Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: user.id, username: user.username } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) {
      const db = await dbPromise;
      await deleteSessionByTokenHash(db, hashToken(token));
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function getFeedIn() {
  return config.get().feedInCzkPerKwh;
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
  const lanUser = String(process.env.LAN_WEB_USER || "").trim();
  const lanPass = String(process.env.LAN_WEB_PASSWORD || "").trim();
  res.json({
    ok: true,
    goodweHostConfigured: Boolean(c.goodweHost),
    lanWebEnabled: Boolean(c.lanWebEnabled),
    lanWebBaseUrlConfigured: Boolean(c.lanWebBaseUrl),
    lanWebCredentialsConfigured: Boolean(lanUser && lanPass),
    pollIntervalMs: c.pollIntervalMs,
    port: PORT,
  });
});

app.get("/api/live", async (_req, res) => {
  try {
    const db = await dbPromise;
    const row = await latestReading(db);
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
      feedInCzkPerKwh: fi,
      estimatedIncomeCzk: income,
      ...row.payload,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/series", async (req, res) => {
  try {
    const db = await dbPromise;
    const limit = Math.min(2000, Math.max(10, Number(req.query.limit) || 360));
    const series = await recentSeries(db, limit);
    res.json({ series });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

function seriesBucketT(range, ts) {
  const d = new Date(ts);
  if (range === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === "year") {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const bucketMs =
    range === "day" ? 5 * 60 * 1000 : 15 * 60 * 1000;
  return Math.floor(ts / bucketMs) * bucketMs;
}

app.get("/api/series-range", async (req, res) => {
  try {
    const db = await dbPromise;
    const range = String(req.query.range || "day").toLowerCase();
    const { fromTs, toTs } = getRangeBounds(range, Date.now());
    const raw = (await rowsForRange(db, fromTs, toTs, 250000)).filter((r) => r.ok);

    const bucketMs =
      range === "day"
        ? 5 * 60 * 1000
        : range === "month"
          ? 31 * 24 * 60 * 60 * 1000
          : range === "year"
            ? 366 * 24 * 60 * 60 * 1000
            : 15 * 60 * 1000;

    const bucketKind =
      range === "month" ? "calendarMonth" : range === "year" ? "calendarYear" : "time";

    const buckets = new Map();
    for (const r of raw) {
      const b = seriesBucketT(range, r.ts);
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

    res.json({ range, bucketMs, bucketKind, series });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const db = await dbPromise;
    const range = String(req.query.range || "day").toLowerCase();
    const s = await statsByPreset(db, range, Date.now());
    const fi = getFeedIn();
    const income =
      s.productionKwh != null ? Number(s.productionKwh) * fi : null;
    res.json({
      ...s,
      estimatedIncomeCzk: income,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/stats/snapshot", async (req, res) => {
  try {
    const db = await dbPromise;
    const s = await statsSnapshot(db, Date.now());
    const fi = getFeedIn();
    const withIncome = (b) => {
      if (!b || b.samples === 0) return { ...b, estimatedIncomeCzk: null };
      const income =
        b.productionKwh != null ? Number(b.productionKwh) * fi : null;
      return { ...b, estimatedIncomeCzk: income };
    };
    const all = s.allTime || {};
    const { firstDataTs, lastDataTs, ...allRest } = all;
    const allWithIncome = withIncome(allRest);
    res.json({
      ok: true,
      nowTs: s.nowTs,
      day: withIncome(s.day),
      month: withIncome(s.month),
      year: withIncome(s.year),
      allTime: {
        ...allWithIncome,
        firstDataTs: firstDataTs ?? null,
        lastDataTs: lastDataTs ?? null,
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/stats/breakdown", async (req, res) => {
  try {
    const db = await dbPromise;
    const g = String(req.query.granularity || "years").toLowerCase();
    const year = req.query.year != null ? Number(req.query.year) : undefined;
    const month = req.query.month != null ? Number(req.query.month) : undefined;
    const b = await statsBreakdown(db, g, year, month, Date.now());
    const fi = getFeedIn();
    const items = (b.items || []).map((it) => ({
      ...it,
      estimatedIncomeCzk:
        it.productionKwh != null ? Number(it.productionKwh) * fi : null,
    }));
    res.json({ ok: true, ...b, items });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/stats/monthly-matrix", async (req, res) => {
  try {
    const db = await dbPromise;
    const m = await statsMonthlyMatrix(db, Date.now());
    res.json({ ok: true, ...m });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/export/xls", async (req, res) => {
  try {
    const db = await dbPromise;
    const range = String(req.query.range || "day").toLowerCase();
    const { fromTs, toTs } = getRangeBounds(range, Date.now());
    const rows = (await rowsForRange(db, fromTs, toTs, 200000)).map((r) => ({
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
      e_day_export_kwh: r.e_day_export_kwh,
      e_day_import_kwh: r.e_day_import_kwh,
      e_total_kwh: r.e_total_kwh,
      e_load_total_kwh: r.e_load_total_kwh,
      e_total_export_kwh: r.e_total_export_kwh,
      e_total_import_kwh: r.e_total_import_kwh,
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
    const db = await dbPromise;
    const gwPayload = await fetchFromInverter(c.pythonExe, c.goodweHost);
    let payload = { ...gwPayload };
    const lanWanted =
      Boolean(c.lanWebEnabled) && String(c.lanWebBaseUrl || "").trim().length > 0;
    if (lanWanted) {
      const lanUser = String(process.env.LAN_WEB_USER || "").trim();
      const lanPass = String(process.env.LAN_WEB_PASSWORD || "").trim();
      if (!lanUser || !lanPass) {
        payload = {
          ...payload,
          lan_web: {
            ok: false,
            error:
              "Chybí LAN_WEB_USER nebo LAN_WEB_PASSWORD v prostředí serveru (.env).",
            source: "lan_web",
          },
        };
      } else {
        const lanEnv = {
          LAN_WEB_BASE_URL: String(c.lanWebBaseUrl).trim(),
          LAN_WEB_USER: lanUser,
          LAN_WEB_PASSWORD: lanPass,
        };
        const lp = String(c.lanWebLoginPath || "").trim();
        if (lp) lanEnv.LAN_WEB_LOGIN_PATH = lp;
        const dp = String(c.lanWebDataPath || "").trim();
        if (dp) lanEnv.LAN_WEB_DATA_PATH = dp;
        const ap = String(c.lanWebAltPath || "").trim();
        if (ap) lanEnv.LAN_WEB_ALT_PATH = ap;
        try {
          const lan = await fetchFromLanWeb(c.pythonExe, lanEnv);
          payload = { ...payload, lan_web: lan };
        } catch (e) {
          payload = {
            ...payload,
            lan_web: {
              ok: false,
              error: String(e.message || e),
              source: "lan_web",
            },
          };
        }
      }
    }
    // Úspěch řádku = jen GoodWe (střídač). Selhání A-ZROUTER (Playwright) nesmí shodit živá data ani „Chyba čtení“.
    const ok = Boolean(gwPayload.ok);
    await insertReading(db, ok, payload);
    broadcast({
      type: "reading",
      ok,
      ts: Date.now(),
      feedInCzkPerKwh: c.feedInCzkPerKwh,
      payload,
    });
  } catch (e) {
    const fail = {
      ok: false,
      error: String(e.message || e),
      ts: new Date().toISOString(),
    };
    const db = await dbPromise;
    await insertReading(db, false, fail);
    broadcast({
      type: "reading",
      ok: false,
      ts: Date.now(),
      feedInCzkPerKwh: c.feedInCzkPerKwh,
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

wss.on("connection", async (ws, req) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) {
    ws.close();
    return;
  }
  const db = await dbPromise;
  const session = await getSessionWithUserByTokenHash(db, hashToken(token));
  if (!session) {
    ws.close();
    return;
  }
  const c = config.get();
  ws.send(JSON.stringify({ type: "config", ...c }));
  const row = await latestReading(db);
  if (row) {
    ws.send(
      JSON.stringify({
        type: "reading",
        ok: row.ok,
        ts: row.ts,
        feedInCzkPerKwh: c.feedInCzkPerKwh,
        payload: row.payload,
      })
    );
  }
});

(async () => {
  try {
    const db = await dbPromise;
    await pruneExpiredSessions(db);
    setInterval(() => pruneExpiredSessions(db).catch(() => {}), 60 * 60 * 1000);
    server.listen(PORT, () => {
      console.log(`HomeAPP GoodWe dashboard: http://localhost:${PORT}`);
      restartPolling();
    });
  } catch (e) {
    console.error("Database init failed:", e);
    process.exit(1);
  }
})();
