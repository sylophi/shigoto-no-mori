# /// script
# requires-python = ">=3.11"
# dependencies = ["Pillow>=10.0"]
# ///
"""
Build the app icons — a squircle with a stylized tree, echoing the
TreeDeciduous glyph from the welcome panel.

Produces:
  assets/icon.png        — 1024x1024 master
  assets/icon.svg        — vector master, same geometry
  assets/icon.iconset/   — per-size PNGs for `iconutil`

Run `iconutil -c icns assets/icon.iconset -o assets/icon.icns` after.

The raster and the vector are drawn from the same geometry constants
below, so the two can't drift apart. Those coordinates are unit-relative
(0..1), which also means the same shape works at any output size.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

SIZE = 1024
SS = 4  # supersample factor for crisper edges
CORNER_RADIUS_RATIO = 0.225  # macOS Big Sur+ squircle approximation

# --- geometry, unit-relative -------------------------------------------------
# Three overlapping circles form the crown; the chin ellipse fills the
# gap where the lobes meet so the silhouette stays unbroken.
CROWN = [
    ((0.50, 0.32), 0.20),
    ((0.34, 0.50), 0.21),
    ((0.66, 0.50), 0.21),
]
CHIN = (0.36, 0.42, 0.64, 0.66)  # bounding box
TRUNK_TOP = 0.62
TRUNK_BOT = 0.84
TRUNK_HALF_TOP = 0.045
TRUNK_HALF_BOT = 0.06


@dataclass(frozen=True)
class Theme:
    """Background is a vertical gradient; equal stops render flat."""

    bg_top: tuple[int, int, int]
    bg_bottom: tuple[int, int, int]
    leaf: tuple[int, int, int]


THEMES = {
    # The original deep-forest mark.
    "forest": Theme(
        bg_top=(28, 95, 56),
        bg_bottom=(14, 55, 36),
        leaf=(245, 245, 244),
    ),
    # Doubutsu: leaf green settling onto --primary (#29ac68) at the
    # bottom, under a tree in --background cream.
    "doubutsu": Theme(
        bg_top=(58, 196, 124),
        bg_bottom=(41, 172, 104),
        leaf=(250, 246, 238),
    ),
}


def hexcolor(rgb: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*rgb)


# --- raster ------------------------------------------------------------------
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


def draw_tree(canvas: Image.Image, theme: Theme) -> None:
    """Draw the filled tree, composed at supersample resolution to keep
    edges crisp."""
    w = canvas.size[0]
    layer = Image.new("RGBA", (w * SS, w * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    def scaled(value: float) -> int:
        return round(value * w * SS)

    cx = scaled(0.5)

    for (ux, uy), r in CROWN:
        rx, ry, rr = scaled(ux), scaled(uy), scaled(r)
        d.ellipse((rx - rr, ry - rr, rx + rr, ry + rr), fill=theme.leaf)

    d.ellipse(tuple(scaled(v) for v in CHIN), fill=theme.leaf)

    # Trunk: short, slightly tapered.
    trunk_top = scaled(TRUNK_TOP)
    trunk_bot = scaled(TRUNK_BOT)
    half_top = scaled(TRUNK_HALF_TOP)
    half_bot = scaled(TRUNK_HALF_BOT)
    d.polygon(
        [
            (cx - half_top, trunk_top),
            (cx + half_top, trunk_top),
            (cx + half_bot, trunk_bot),
            (cx - half_bot, trunk_bot),
        ],
        fill=theme.leaf,
    )
    # Round the trunk base.
    d.ellipse(
        (cx - half_bot, trunk_bot - half_bot, cx + half_bot, trunk_bot + half_bot),
        fill=theme.leaf,
    )

    canvas.alpha_composite(layer.resize((w, w), Image.LANCZOS))


def build_master(theme: Theme) -> Image.Image:
    bg = vertical_gradient(SIZE, theme.bg_top, theme.bg_bottom).convert("RGBA")
    mask = rounded_mask(SIZE, round(SIZE * CORNER_RADIUS_RATIO))
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(bg, mask=mask)
    draw_tree(canvas, theme)
    return canvas


# --- vector ------------------------------------------------------------------
def build_svg(theme: Theme) -> str:
    """Same shapes as the raster, at the same unit coordinates scaled to
    the 1024 viewBox."""
    s = float(SIZE)

    def u(value: float) -> float:
        return round(value * s, 3)

    leaf = hexcolor(theme.leaf)
    flat = theme.bg_top == theme.bg_bottom
    bg_fill = hexcolor(theme.bg_top) if flat else "url(#bg)"

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{SIZE}" height="{SIZE}" '
        f'viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="Shigoto no Mori">',
    ]
    if not flat:
        parts += [
            "  <defs>",
            '    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1" '
            'gradientUnits="objectBoundingBox">',
            f'      <stop offset="0" stop-color="{hexcolor(theme.bg_top)}"/>',
            f'      <stop offset="1" stop-color="{hexcolor(theme.bg_bottom)}"/>',
            "    </linearGradient>",
            "  </defs>",
        ]
    parts.append(
        f'  <rect width="{SIZE}" height="{SIZE}" rx="{u(CORNER_RADIUS_RATIO)}" fill="{bg_fill}"/>'
    )
    parts.append(f'  <g fill="{leaf}">')

    for (ux, uy), r in CROWN:
        parts.append(f'    <circle cx="{u(ux)}" cy="{u(uy)}" r="{u(r)}"/>')

    x0, y0, x1, y1 = CHIN
    parts.append(
        f'    <ellipse cx="{u((x0 + x1) / 2)}" cy="{u((y0 + y1) / 2)}" '
        f'rx="{u((x1 - x0) / 2)}" ry="{u((y1 - y0) / 2)}"/>'
    )

    pts = " ".join(
        f"{u(x)},{u(y)}"
        for x, y in [
            (0.5 - TRUNK_HALF_TOP, TRUNK_TOP),
            (0.5 + TRUNK_HALF_TOP, TRUNK_TOP),
            (0.5 + TRUNK_HALF_BOT, TRUNK_BOT),
            (0.5 - TRUNK_HALF_BOT, TRUNK_BOT),
        ]
    )
    parts.append(f'    <polygon points="{pts}"/>')
    parts.append(
        f'    <circle cx="{u(0.5)}" cy="{u(TRUNK_BOT)}" r="{u(TRUNK_HALF_BOT)}"/>'
    )
    parts += ["  </g>", "</svg>", ""]
    return "\n".join(parts)


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
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--theme", choices=sorted(THEMES), default="doubutsu")
    ap.add_argument("--out-dir", type=Path, default=ASSETS)
    args = ap.parse_args()

    theme = THEMES[args.theme]
    out = args.out_dir
    iconset = out / "icon.iconset"
    out.mkdir(parents=True, exist_ok=True)
    iconset.mkdir(exist_ok=True)

    master = build_master(theme)
    master.save(out / "icon.png", format="PNG")
    (out / "icon.svg").write_text(build_svg(theme))

    for name, px in ICONSET_SIZES:
        master.resize((px, px), Image.LANCZOS).save(iconset / name, format="PNG")

    print(f"wrote {out / 'icon.png'}, {out / 'icon.svg'} and {len(ICONSET_SIZES)} sized PNGs")
    print(f"now run: iconutil -c icns {iconset} -o {out / 'icon.icns'}")


if __name__ == "__main__":
    main()
