/**
 * Spouští se v kontextu stránky (page.evaluate).
 * A-ZROUTER: přehled #/ (teplota u ikony, „Active: #1 Bojler“) + #/devices (9 / 85 °C, „active“ u karty).
 */
() => {
  const raw = document.body ? document.body.innerText : "";
  const text = raw.replace(/\u00a0/g, " ");
  const compact = text.replace(/\s+/g, " ");
  const out = { source: "azrouter" };

  // „Active: #1 Bojler“ na přehledu (Saved Power)
  if (/Active:\s*#\s*\d+[^\n]*Bojler/i.test(text) || /Active:\s*#\d+.*Bojler/i.test(compact)) {
    out.boiler_status_active = true;
  }

  // Karta zařízení: „9 / 85 °C“ (i desetinná čísla)
  const frac = compact.match(
    /(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*°\s*C/i
  );
  if (frac) {
    out.boiler_water_temp_c = parseFloat(String(frac[1]).replace(",", "."));
    out.boiler_target_temp_c = parseFloat(String(frac[2]).replace(",", "."));
  }

  // Přehled / jednotlivá hodnota: první „NN °C“ v rozmezí cca vody 5–98 (včetně 9 °C na kartě)
  if (out.boiler_water_temp_c == null || Number.isNaN(out.boiler_water_temp_c)) {
    const re = /(\d{1,2}(?:[.,]\d+)?)\s*°\s*C/gi;
    let m;
    const candidates = [];
    while ((m = re.exec(compact)) !== null) {
      const v = parseFloat(String(m[1]).replace(",", "."));
      if (v >= 5 && v <= 98) candidates.push(v);
    }
    if (candidates.length) {
      out.boiler_water_temp_c = candidates[0];
    }
  }

  // Stav u karty Bojler (zařízení): „active“ v úseku s Bojler
  const low = compact.toLowerCase();
  const idx = low.indexOf("bojler");
  let slice = compact;
  if (idx >= 0) {
    slice = compact.slice(Math.max(0, idx - 80), idx + 950);
  }
  const hasActiveWord = /\bactive\b/i.test(slice);
  const hasInactiveWord = /\binactive\b/i.test(slice);
  if (out.boiler_status_active !== true) {
    if (hasActiveWord && !hasInactiveWord) {
      out.boiler_status_active = true;
    } else if (hasInactiveWord) {
      out.boiler_status_active = false;
    }
  }

  if (/\bSystem online\b/i.test(compact)) {
    out.system_online = true;
  }

  const sw =
    document.querySelector('[role="switch"]') ||
    document.querySelector(".el-switch .el-switch__input") ||
    document.querySelector('input[type="checkbox"]');
  if (sw) {
    const ac = sw.getAttribute("aria-checked");
    if (ac === "true") out.boiler_switch_on = true;
    else if (ac === "false") out.boiler_switch_on = false;
    else if (typeof sw.checked === "boolean") out.boiler_switch_on = sw.checked;
  }

  return out;
}
