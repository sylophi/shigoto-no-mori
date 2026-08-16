// Regenerates the menu bar template icon embedded in
// main/electron/tray/icon.ts.
//
// The icon ships as base64 inside a .ts module rather than as a PNG in
// assets/: the packaged app is an asar bundle built by the Vite plugin,
// which only carries the compiled main/preload/renderer output, so a
// loose image file would need its own copy step and a dev-vs-packaged
// path fork. A string constant is identical in both.
//
// The artwork is the lucide `git-branch` glyph, drawn here with a tiny
// signed-distance rasterizer (4x4 supersampled) instead of a real SVG
// renderer so this script has no dependencies. macOS template images
// use the alpha channel only, so the output is 8-bit grayscale+alpha
// with every pixel black.
//
//   node scripts/generate-tray-icon.mjs        # prints the TS constants
//   node scripts/generate-tray-icon.mjs --check # verifies icon.ts matches
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Artwork coordinates are lucide's 24x24 viewBox.
const VIEWBOX = 24;
const STROKE = 2.2;

// lucide git-branch: a stem, two nodes, and a quarter-arc joining them.
const stem = { kind: "segment", a: [6, 3], b: [6, 15] };
const upperNode = { kind: "ring", c: [18, 6], r: 3 };
const lowerNode = { kind: "ring", c: [6, 18], r: 3 };
// `M18 9 a9 9 0 0 1 -9 9` -- centered at (9,9), radius 9, sweeping the
// quarter from due-east to due-south in screen coordinates.
const arc = { kind: "arc", c: [9, 9], r: 9, from: 0, to: Math.PI / 2 };
const SHAPES = [stem, upperNode, lowerNode, arc];

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function distanceToShape(x, y, shape) {
  switch (shape.kind) {
    case "segment":
      return distanceToSegment(x, y, shape.a, shape.b);
    case "ring":
      return Math.abs(Math.hypot(x - shape.c[0], y - shape.c[1]) - shape.r);
    case "arc": {
      const [cx, cy] = shape.c;
      // Screen coordinates: y grows downward, so a positive angle here
      // sweeps clockwise on screen, matching the SVG arc's direction.
      let angle = Math.atan2(y - cy, x - cx);
      if (angle < 0) angle += 2 * Math.PI;
      if (angle >= shape.from && angle <= shape.to) {
        return Math.abs(Math.hypot(x - cx, y - cy) - shape.r);
      }
      // Outside the sweep: round-cap on whichever endpoint is nearer.
      const ends = [shape.from, shape.to].map((a) => [
        cx + shape.r * Math.cos(a),
        cy + shape.r * Math.sin(a),
      ]);
      return Math.min(...ends.map(([ex, ey]) => Math.hypot(x - ex, y - ey)));
    }
    default:
      throw new Error(`unknown shape: ${shape.kind}`);
  }
}

// Coverage of one output pixel, 4x4 supersampled. `pad` insets the
// artwork so strokes never touch the bitmap edge (macOS crops nothing,
// but a flush stroke reads as a cut-off shape next to the menu text).
function coverage(px, py, size, pad) {
  const inner = size - 2 * pad;
  const scale = inner / VIEWBOX;
  const half = (STROKE * scale) / 2;
  const samples = 4;
  let hits = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const x = (px + (sx + 0.5) / samples - pad) / scale;
      const y = (py + (sy + 0.5) / samples - pad) / scale;
      // Antialias across one output pixel's worth of distance.
      const d = Math.min(...SHAPES.map((s) => distanceToShape(x, y, s)));
      const edge = (0.5 / scale) * 0.9;
      const alpha = Math.max(0, Math.min(1, (half + edge - d) / (2 * edge)));
      hits += alpha;
    }
  }
  return hits / (samples * samples);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// 8-bit grayscale + alpha (color type 4), every pixel black.
function encodePng(size, alphas) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  const raw = Buffer.alloc(size * (1 + size * 2));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 2);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[rowStart + 1 + x * 2] = 0;
      raw[rowStart + 2 + x * 2] = alphas[y * size + x];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(size, pad) {
  const alphas = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      alphas[y * size + x] = Math.round(coverage(x, y, size, pad) * 255);
    }
  }
  return encodePng(size, alphas).toString("base64");
}

const ONE_X = render(16, 1);
const TWO_X = render(32, 2);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconPath = join(root, "main/electron/tray/icon.ts");

if (process.argv.includes("--check")) {
  const source = readFileSync(iconPath, "utf8");
  const stale = [ONE_X, TWO_X].filter((b64) => !source.includes(b64));
  if (stale.length > 0) {
    console.error(
      "main/electron/tray/icon.ts is out of date -- re-run scripts/generate-tray-icon.mjs",
    );
    process.exit(1);
  }
  console.log("tray icon OK");
} else {
  console.log(`const TRAY_ICON_1X = "${ONE_X}";`);
  console.log(`const TRAY_ICON_2X = "${TWO_X}";`);
}
