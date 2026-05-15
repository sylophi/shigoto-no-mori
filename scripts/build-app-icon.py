# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow>=10.0"]
# ///
"""
Build the macOS app icon (.icns) — a deep-emerald squircle with a stylized
tree, echoing the TreeDeciduous glyph from the welcome panel.

Produces:
  assets/icon.png        — 1024x1024 master
  assets/icon.iconset/   — per-size PNGs for `iconutil`

Run `iconutil -c icns assets/icon.iconset -o assets/icon.icns` after.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ICONSET = ASSETS / "icon.iconset"

SIZE = 1024
SS = 4  # supersample factor for crisper edges
CORNER_RADIUS_RATIO = 0.225  # macOS Big Sur+ squircle approximation
BG_TOP = (28, 95, 56)        # emerald-ish
BG_BOTTOM = (14, 55, 36)     # deep forest
LEAF = (245, 245, 244)       # warm white
TRUNK = (245, 245, 244)


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """Smooth top→bottom gradient as an RGB image."""
    strip = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        strip.putpixel(
            (0, y),
            (
                round(top[0] + (bottom[0] - top[0]) * t),
                round(top[1] + (bottom[1] - top[1]) * t),
                round(top[2] + (bottom[2] - top[2]) * t),
            ),
        )
    return strip.resize((size, size))


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def draw_tree(canvas: Image.Image) -> None:
    """Draw a stylized filled tree (three overlapping leaf lobes + trunk),
    composed at supersample resolution to keep edges crisp."""
    w = canvas.size[0]
    layer = Image.new("RGBA", (w * SS, w * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def scaled(value: float) -> int:
        return round(value * w * SS)

    cx = scaled(0.5)
    # Three overlapping circles form the crown; coords are unit-relative so
    # the same shape works at any output size.
    crown = [
        ((0.50, 0.32), 0.20),
        ((0.34, 0.50), 0.21),
        ((0.66, 0.50), 0.21),
    ]
    for (ux, uy), r in crown:
        rx, ry, rr = scaled(ux), scaled(uy), scaled(r)
        d.ellipse((rx - rr, ry - rr, rx + rr, ry + rr), fill=LEAF)

    # Fill the chin where the lobes meet — keeps the silhouette unbroken.
    d.ellipse(
        (scaled(0.36), scaled(0.42), scaled(0.64), scaled(0.66)),
        fill=LEAF,
    )

    # Trunk: short, slightly tapered.
    trunk_top = scaled(0.62)
    trunk_bot = scaled(0.84)
    half_top = scaled(0.045)
    half_bot = scaled(0.06)
    d.polygon(
        [
            (cx - half_top, trunk_top),
            (cx + half_top, trunk_top),
            (cx + half_bot, trunk_bot),
            (cx - half_bot, trunk_bot),
        ],
        fill=TRUNK,
    )
    # Round the trunk base.
    d.ellipse(
        (cx - half_bot, trunk_bot - half_bot, cx + half_bot, trunk_bot + half_bot),
        fill=TRUNK,
    )

    canvas.alpha_composite(layer.resize((w, w), Image.LANCZOS))


def build_master() -> Image.Image:
    bg = vertical_gradient(SIZE, BG_TOP, BG_BOTTOM).convert("RGBA")
    mask = rounded_mask(SIZE, round(SIZE * CORNER_RADIUS_RATIO))
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(bg, mask=mask)
    draw_tree(canvas)
    return canvas


ICONSET_SIZES: list[tuple[str, int]] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    ICONSET.mkdir(exist_ok=True)

    master = build_master()
    master.save(ASSETS / "icon.png", format="PNG")

    for name, px in ICONSET_SIZES:
        master.resize((px, px), Image.LANCZOS).save(ICONSET / name, format="PNG")

    print(f"wrote {ASSETS / 'icon.png'} and {len(ICONSET_SIZES)} sized PNGs")
    print("now run: iconutil -c icns assets/icon.iconset -o assets/icon.icns")


if __name__ == "__main__":
    main()
