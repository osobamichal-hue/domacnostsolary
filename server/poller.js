const { spawn } = require("child_process");
const path = require("path");

function fetchFromLanWeb(pythonExe, env) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "..", "python", "fetch_lan_web.py");
    const timeoutMs = Math.max(
      15000,
      Number(process.env.LAN_WEB_NODE_TIMEOUT_MS || 120000)
    );
    let finished = false;
    const child = spawn(pythonExe, [script], {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(
        new Error(
          `LAN web (Playwright): překročen čas ${timeoutMs} ms — zvyšte LAN_WEB_NODE_TIMEOUT_MS nebo interval pollingu.`
        )
      );
    }, timeoutMs);

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const lines = out.trim().split("\n").filter(Boolean);
      const text = lines.length ? lines[lines.length - 1] : "";
      if (!text) {
        reject(new Error(err || `Python (LAN web) skončil s kódem ${code}, bez výstupu`));
        return;
      }
      try {
        const json = JSON.parse(text);
        resolve(json);
      } catch (e) {
        reject(new Error(`Neplatný JSON z Pythonu (LAN web): ${text.slice(0, 200)}`));
      }
    });
  });
}

function fetchFromInverter(pythonExe, goodweHost) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "..", "python", "fetch_runtime.py");
    const child = spawn(pythonExe, [script], {
      env: { ...process.env, GOODWE_HOST: goodweHost },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out.trim().split("\n").filter(Boolean);
      const text = lines.length ? lines[lines.length - 1] : "";
      if (!text) {
        reject(new Error(err || `Python skončil s kódem ${code}, bez výstupu`));
        return;
      }
      try {
        const json = JSON.parse(text);
        resolve(json);
      } catch (e) {
        reject(new Error(`Neplatný JSON z Pythonu: ${text.slice(0, 200)}`));
      }
    });
  });
}

module.exports = { fetchFromInverter, fetchFromLanWeb };
