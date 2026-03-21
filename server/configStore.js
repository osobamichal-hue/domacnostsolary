"use strict";

const fs = require("fs");
const path = require("path");

const FILENAME = "app-config.json";

function defaultsFromEnv() {
  return {
    goodweHost: String(process.env.GOODWE_HOST || "").trim(),
    pollIntervalMs: Math.max(
      5000,
      Number(process.env.POLL_INTERVAL_MS || 10000)
    ),
    feedInCzkPerKwh: Number(
      process.env.FEED_IN_CZK_PER_KWH || process.env.FEED_IN_EUR_PER_KWH || 5.5
    ),
    pythonExe: String(process.env.PYTHON_EXE || "python").trim(),
  };
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function merge(base, file) {
  const out = { ...base };
  if (file.goodweHost !== undefined) out.goodweHost = String(file.goodweHost).trim();
  if (file.pollIntervalMs !== undefined) {
    out.pollIntervalMs = Math.max(5000, Number(file.pollIntervalMs));
  }
  if (file.feedInCzkPerKwh !== undefined) {
    out.feedInCzkPerKwh = Number(file.feedInCzkPerKwh);
  } else if (file.feedInEurPerKwh !== undefined) {
    // Backward compatibility se starším klíčem
    out.feedInCzkPerKwh = Number(file.feedInEurPerKwh);
  }
  if (file.pythonExe !== undefined) {
    out.pythonExe = String(file.pythonExe).trim();
  }
  return out;
}

function clampPoll(ms) {
  const n = Number(ms);
  if (Number.isNaN(n)) return 10000;
  return Math.min(86_400_000, Math.max(5000, Math.round(n)));
}

function validatePatch(patch) {
  const err = [];
  if (patch.goodweHost !== undefined) {
    const h = String(patch.goodweHost).trim();
    if (h.length > 253) err.push("Adresa střídače je příliš dlouhá.");
  }
  if (patch.pollIntervalMs !== undefined) {
    const p = Number(patch.pollIntervalMs);
    if (Number.isNaN(p) || p < 5000 || p > 86_400_000) {
      err.push("Interval dotazování musí být 5 s až 24 h.");
    }
  }
  if (patch.feedInCzkPerKwh !== undefined || patch.feedInEurPerKwh !== undefined) {
    const f = Number(
      patch.feedInCzkPerKwh !== undefined
        ? patch.feedInCzkPerKwh
        : patch.feedInEurPerKwh
    );
    if (Number.isNaN(f) || f < 0 || f > 999) {
      err.push("Cena za kWh musí být 0–999.");
    }
  }
  if (patch.pythonExe !== undefined) {
    const py = String(patch.pythonExe).trim();
    if (!py.length) err.push("Zadejte příkaz pro Python (např. py nebo python).");
    if (py.length > 512) err.push("Příkaz Python je příliš dlouhý.");
  }
  return err;
}

function createConfigStore(dataDir) {
  const filePath = path.join(dataDir, FILENAME);
  const base = defaultsFromEnv();
  let data = merge(base, readJsonFile(filePath));

  function persist() {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          goodweHost: data.goodweHost,
          pollIntervalMs: data.pollIntervalMs,
          feedInCzkPerKwh: data.feedInCzkPerKwh,
          pythonExe: data.pythonExe,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  function get() {
    return {
      goodweHost: data.goodweHost,
      pollIntervalMs: data.pollIntervalMs,
      feedInCzkPerKwh: data.feedInCzkPerKwh,
      pythonExe: data.pythonExe,
    };
  }

  function update(patch) {
    const errors = validatePatch(patch);
    if (errors.length) {
      const e = new Error(errors.join(" "));
      e.code = "VALIDATION";
      throw e;
    }
    const next = { ...data };
    if (patch.goodweHost !== undefined) next.goodweHost = String(patch.goodweHost).trim();
    if (patch.pollIntervalMs !== undefined) {
      next.pollIntervalMs = clampPoll(patch.pollIntervalMs);
    }
    if (patch.feedInCzkPerKwh !== undefined) {
      next.feedInCzkPerKwh = Number(patch.feedInCzkPerKwh);
    } else if (patch.feedInEurPerKwh !== undefined) {
      next.feedInCzkPerKwh = Number(patch.feedInEurPerKwh);
    }
    if (patch.pythonExe !== undefined) {
      next.pythonExe = String(patch.pythonExe).trim();
    }
    data = next;
    persist();
    return get();
  }

  return { get, update };
}

module.exports = { createConfigStore };
