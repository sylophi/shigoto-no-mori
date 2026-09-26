// A character's own color, read off their face, for their name plate
// the way each villager's dialogue in Animal Crossing carries one:
// Katrina's violet, Tom Nook's brown. The face's most present saturated
// hue, set at a lightness white text reads on, or null for a face with
// no clear color (K.K. Slider's white), which takes the plate's default.
// Read once per face and kept for the window's life.

const SIDE = 32;
const BINS = 24;

const byFace = new Map<string, Promise<string | null>>();

export function faceColor(face: string): Promise<string | null> {
  let color = byFace.get(face);
  if (color === undefined) {
    color = read(face).catch(() => null);
    byFace.set(face, color);
  }
  return color;
}

async function read(face: string): Promise<string | null> {
  const image = new Image();
  image.src = face;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(image, 0, 0, SIDE, SIDE);
  const { data } = context.getImageData(0, 0, SIDE, SIDE);

  // Each hue bin weighs its pixels by how saturated they are, and keeps
  // a saturation sum to set the plate's.
  const weight = new Float64Array(BINS);
  const hueX = new Float64Array(BINS);
  const hueY = new Float64Array(BINS);
  const saturation = new Float64Array(BINS);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const [h, s, l] = hsl(data[i], data[i + 1], data[i + 2]);
    // Outlines, highlights and greys say nothing about the character.
    if (s < 0.3 || l < 0.18 || l > 0.85) continue;
    const bin = Math.floor((h / 360) * BINS) % BINS;
    weight[bin] += s;
    hueX[bin] += Math.cos((h * Math.PI) / 180) * s;
    hueY[bin] += Math.sin((h * Math.PI) / 180) * s;
    saturation[bin] += s * s;
  }
  let best = 0;
  for (let bin = 1; bin < BINS; bin++) {
    if (weight[bin] > weight[best]) best = bin;
  }
  // Too little color to call it theirs.
  if (weight[best] < SIDE * SIDE * 0.04) return null;
  const hue = (Math.atan2(hueY[best], hueX[best]) * 180) / Math.PI;
  const sat = Math.min(0.75, saturation[best] / weight[best]);
  return `hsl(${Math.round((hue + 360) % 360)} ${Math.round(sat * 100)}% 42%)`;
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === red
      ? (green - blue) / d + (green < blue ? 6 : 0)
      : max === green
        ? (blue - red) / d + 2
        : (red - green) / d + 4;
  return [h * 60, s, l];
}
