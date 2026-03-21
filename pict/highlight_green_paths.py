# -*- coding: utf-8 -*-
"""
Najde neonové / zelené energetické čáry na podkladových PNG a zvýrazní je
přesně podle masky pixelů (orientace – kde v obrázku čáry jsou).

Spuštění z kořene projektu:
  py pict/highlight_green_paths.py

Výstup: pict/orientace/<název>_orientace.png
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "orientace"

# Zvýraznění: jasná barva „navrch“ podél detekovaných pixelů (alpha blend v maskě)
HIGHLIGHT_RGB = np.array([80, 255, 140], dtype=np.float32)
BLEND_ORIG = 0.35  # kolik ponechat originálu na zelené trase (nižší = výraznější čára)


def rgb_to_hsv_array(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """rgb: HxWx3 float 0..255 -> h,s,v 0..1"""
    r = rgb[..., 0].astype(np.float32) / 255.0
    g = rgb[..., 1].astype(np.float32) / 255.0
    b = rgb[..., 2].astype(np.float32) / 255.0
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    diff = mx - mn
    diff = np.where(diff < 1e-6, 1e-6, diff)

    h = np.zeros_like(mx)
    s = np.zeros_like(mx)
    v = mx

    mask = diff > 1e-6
    h = np.where(mask & (mx == r), ((g - b) / diff) % 6.0, h)
    h = np.where(mask & (mx == g), (b - r) / diff + 2.0, h)
    h = np.where(mask & (mx == b), (r - g) / diff + 4.0, h)
    h = (h / 6.0) % 1.0
    s = np.where(mx > 0, diff / mx, 0.0)

    return h, s, v


def green_line_mask(rgb: np.ndarray) -> np.ndarray:
    """
    Maska pixelů odpovídajících zeleným / neonovým energetickým čarám.
    """
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)

    h, s, v = rgb_to_hsv_array(rgb)

    # Neon zelená: Hue kolem 0.25–0.45 (≈ 90–160°), dostatečná saturace, ne úplně černá
    hue_ok = (h >= 0.22) & (h <= 0.48)
    sat_ok = s >= 0.25
    val_ok = v >= 0.12

    # Doplňkově: čistě „G dominuje“ (některé rendery mimo čisté HSV)
    g_dom = (g > 55) & (g > r + 18) & (g > b + 18) & ((g - np.minimum(r, b)) > 25)

    mask = (hue_ok & sat_ok & val_ok) | g_dom

    # Odfiltrovat velké plochy stejné barvy (např. okna) – čáry jsou relativně úzké;
    # zahodíme velmi vysoké V s nízkou S (téměř bílá)
    not_white = ~((v > 0.92) & (s < 0.15))
    mask = mask & not_white

    return mask


def dilate_mask(mask: np.ndarray, iterations: int = 1) -> np.ndarray:
    """Dilatace 3x3 – spojí drobná přerušení čáry."""
    im = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    for _ in range(iterations):
        im = im.filter(ImageFilter.MaxFilter(3))
    return np.array(im) > 128


def highlight_along_mask(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Ponechá pozadí, na masce přesně zvýrazní barvu podél čáry."""
    out = rgb.astype(np.float32).copy()
    m = mask[..., np.newaxis]
    hi = np.broadcast_to(HIGHLIGHT_RGB, out.shape)
    blended = BLEND_ORIG * out + (1.0 - BLEND_ORIG) * hi
    out = np.where(m, blended, out)
    return np.clip(out, 0, 255).astype(np.uint8)


def process_file(path: Path) -> Path | None:
    img = Image.open(path).convert("RGBA")
    arr = np.array(img)
    rgb = arr[..., :3]

    mask = green_line_mask(rgb)
    mask = dilate_mask(mask, iterations=1)

    new_rgb = highlight_along_mask(rgb, mask)
    out = np.concatenate([new_rgb, arr[..., 3:4]], axis=-1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stem = path.stem
    out_path = OUT_DIR / f"{stem}_orientace.png"
    Image.fromarray(out, "RGBA").save(out_path, optimize=True)
    return out_path


def main() -> None:
    targets = []
    for p in sorted(ROOT.glob("*.png")):
        name = p.name.lower()
        if "tmav" in name and "_" in name:
            targets.append(p)
        if name == "dumtmava.png":
            targets.append(p)

    if not targets:
        print("Nenalezeny žádné vhodné PNG v pict/", file=sys.stderr)
        sys.exit(1)

    for p in targets:
        try:
            outp = process_file(p)
            print(f"OK {p.name} -> {outp.relative_to(ROOT.parent)}")
        except Exception as e:
            print(f"CHYBA {p.name}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
