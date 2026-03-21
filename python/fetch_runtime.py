"""
Jednorázové vyčtení runtime dat ze střídače GoodWe.
Výstup: jeden řádek JSON na stdout (pro Node.js child_process).

Použití:
  set GOODWE_HOST=192.168.1.1 && python fetch_runtime.py
  python fetch_runtime.py 192.168.1.1
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone

import goodwe


def _f(runtime: dict, *keys: str) -> float | None:
    for k in keys:
        if k in runtime and runtime[k] is not None:
            try:
                return float(runtime[k])
            except (TypeError, ValueError):
                continue
    return None


def normalize(runtime: dict) -> dict:
    """Společná pole pro UI (ET/EH i ES/EM apod.)."""
    solar_w = _f(runtime, "ppv")
    grid_w = _f(runtime, "active_power", "pgrid")
    load_w = _f(runtime, "load_ptotal", "house_consumption", "plant_power")
    battery_w = _f(runtime, "pbattery1")
    soc = _f(runtime, "battery_soc")

    e_day = _f(runtime, "e_day")
    e_load_day = _f(runtime, "e_load_day")
    e_day_exp = _f(runtime, "e_day_exp")
    e_day_imp = _f(runtime, "e_day_imp")
    e_total = _f(runtime, "e_total")
    e_load_total = _f(runtime, "e_load_total")
    e_total_exp = _f(runtime, "e_total_exp")
    e_total_imp = _f(runtime, "e_total_imp")

    return {
        "solar_w": solar_w,
        "grid_w": grid_w,
        "load_w": load_w,
        "battery_w": battery_w,
        "battery_soc_pct": soc,
        "e_day_kwh": e_day,
        "e_load_day_kwh": e_load_day,
        "e_day_export_kwh": e_day_exp,
        "e_day_import_kwh": e_day_imp,
        "e_total_kwh": e_total,
        "e_load_total_kwh": e_load_total,
        "e_total_export_kwh": e_total_exp,
        "e_total_import_kwh": e_total_imp,
    }


def runtime_to_flat(runtime: dict, inverter) -> dict:
    out: dict[str, float | int | str | None] = {}
    for sensor in inverter.sensors():
        sid = sensor.id_
        if sid in runtime:
            val = runtime[sid]
            if isinstance(val, (int, float)):
                out[sid] = val
            elif val is None:
                out[sid] = None
            else:
                out[sid] = str(val)
    return out


async def fetch(host: str) -> dict:
    inv = await goodwe.connect(host)
    runtime = await inv.read_runtime_data()
    flat = runtime_to_flat(runtime, inv)
    norm = normalize(runtime)

    return {
        "ok": True,
        "ts": datetime.now(timezone.utc).isoformat(),
        "model_name": inv.model_name,
        "serial_number": inv.serial_number,
        "normalized": norm,
        "sensors": flat,
    }


async def main() -> None:
    host = os.environ.get("GOODWE_HOST") or (sys.argv[1] if len(sys.argv) > 1 else None)
    if not host:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "Chybí IP: nastavte GOODWE_HOST nebo předejte argument.",
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)

    try:
        payload = await fetch(host.strip())
        print(json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        print(
            json.dumps(
                {"ok": False, "error": str(e), "ts": datetime.now(timezone.utc).isoformat()},
                ensure_ascii=False,
            )
        )
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
