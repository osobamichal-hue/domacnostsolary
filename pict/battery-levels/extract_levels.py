# -*- coding: utf-8 -*-
from PIL import Image
from pathlib import Path

src = Path('pict/battery-levels/source-grid.png')
out = Path('pict/battery-levels')
out.mkdir(parents=True, exist_ok=True)
img = Image.open(src).convert('RGB')

xs = [50, 289, 528, 767]
ys = [103, 288, 580, 770]
rel = (0, 0, 220, 122)

light_names = [
    'full', 'high', 'medium', 'low',
    'very_low_a', 'very_low_b', 'critical_a', 'critical_b'
]
dark_names = [
    'full', 'high', 'medium_a', 'medium_b',
    'low', 'very_low_a', 'very_low_b', 'critical'
]

idx = 0
for r in range(2):
    for c in range(4):
        x, y = xs[c], ys[r]
        crop = img.crop((x + rel[0], y + rel[1], x + rel[2], y + rel[3]))
        crop.save(out / f'light_{light_names[idx]}.png')
        idx += 1

idx = 0
for r in range(2, 4):
    for c in range(4):
        x, y = xs[c], ys[r]
        crop = img.crop((x + rel[0], y + rel[1], x + rel[2], y + rel[3]))
        crop.save(out / f'dark_{dark_names[idx]}.png')
        idx += 1

print('done')
