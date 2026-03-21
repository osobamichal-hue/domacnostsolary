const { spawn } = require("child_process");
const path = require("path");

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

module.exports = { fetchFromInverter };
