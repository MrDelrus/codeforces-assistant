#!/usr/bin/env python3
"""Generate the raster icons for both extensions.

Run from the repository root:  python3 tools/make_icons.py

Everything is drawn at 8x and downsampled, which is the cheapest way to get
clean anti-aliased strokes out of PIL.
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

BG = (18, 21, 29, 255)
CHEVRON = (110, 168, 254, 255)
SLASH = (247, 118, 142, 255)
SCALE = 8


def draw_icon(size: int) -> Image.Image:
    s = size * SCALE
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    radius = int(s * 0.22)
    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BG)

    # The glyph is drawn nearly edge to edge on purpose. At 16px in a browser
    # toolbar a mark that keeps a polite margin is a smudge; the background is
    # what gives it its shape there, and the strokes have to carry to the rim.
    margin = 0.10
    stroke = max(2, int(s * 0.105))
    left, right = s * margin, s * (1 - margin)
    top, bottom = s * (margin + 0.02), s * (1 - margin - 0.02)
    mid = s * 0.5
    reach = s * 0.26

    # Left chevron  <
    draw.line([(left + reach, top), (left, mid), (left + reach, bottom)],
              fill=CHEVRON, width=stroke, joint="curve")
    # Right chevron  >
    draw.line([(right - reach, top), (right, mid), (right - reach, bottom)],
              fill=CHEVRON, width=stroke, joint="curve")
    # Slash between them
    draw.line([(s * 0.565, s * (margin - 0.02)), (s * 0.435, s * (1 - margin + 0.02))],
              fill=SLASH, width=max(2, int(stroke * 0.8)))

    return image.resize((size, size), Image.LANCZOS)


def write(path: str, size: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    draw_icon(size).save(path, "PNG")
    print("wrote", os.path.relpath(path, ROOT), f"({size}x{size})")


def main() -> None:
    write(os.path.join(ROOT, "vscode", "media", "icon128.png"), 128)
    for size in (16, 32, 48, 128):
        write(os.path.join(ROOT, "browser", "icons", f"icon{size}.png"), size)


if __name__ == "__main__":
    main()
