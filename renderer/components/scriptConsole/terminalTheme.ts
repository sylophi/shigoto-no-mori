import type { ITheme } from "@xterm/xterm";

// xterm paints its own canvas-like surface, so it can't pick the app's
// theme up from CSS the way DOM text does. Resolve the tokens it needs
// through probe elements instead: `color: var(--token)` computed on a
// child of the console host yields whatever the active theme (light,
// dark, doubutsu) assigns, in a form xterm's color parser accepts.
// Callers re-read on every <html> class change (see ConsoleBody).
// The eight ANSI base colors; each also has a --ansi-bright-* twin
// feeding xterm's bright* key.
const ANSI_BASES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;
type AnsiBase = (typeof ANSI_BASES)[number];

type ThemeColorKey = Exclude<keyof ITheme, "extendedAnsi">;

// xterm parses hex and rgb() directly and hands anything else to a
// canvas, which it only accepts when fully opaque, so the computed
// colors (oklch, and the translucent selection) go through a canvas
// here and come out as #rrggbb[aa].
let scratch: CanvasRenderingContext2D | null = null;
function toHex(color: string): string {
  if (!scratch) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    scratch = canvas.getContext("2d", { willReadFrequently: true });
    if (!scratch) return color;
  }
  scratch.clearRect(0, 0, 1, 1);
  scratch.fillStyle = color;
  scratch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data;
  const parts = a === 255 ? [r, g, b] : [r, g, b, a];
  return `#${parts.map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
}

export function readTerminalTheme(host: HTMLElement): ITheme {
  const entries: Array<[ThemeColorKey, string]> = [
    ["background", "var(--background)"],
    ["foreground", "var(--foreground)"],
    ["cursor", "var(--foreground)"],
    ["cursorAccent", "var(--background)"],
    [
      "selectionBackground",
      "color-mix(in oklab, var(--foreground) 22%, transparent)",
    ],
  ];
  for (const base of ANSI_BASES) {
    const bright =
      `bright${base[0]!.toUpperCase()}${base.slice(1)}` as `bright${Capitalize<AnsiBase>}`;
    entries.push([base, `var(--ansi-${base})`]);
    entries.push([bright, `var(--ansi-bright-${base})`]);
  }
  // All probes go in before any is read: interleaving writes and
  // computed-style reads would force a style recalculation per color.
  const fragment = document.createDocumentFragment();
  const probes = entries.map(([, expr]) => {
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = expr;
    fragment.append(probe);
    return probe;
  });
  host.append(fragment);
  const theme: ITheme = {};
  entries.forEach(([key], i) => {
    theme[key] = toHex(getComputedStyle(probes[i]!).color);
  });
  for (const probe of probes) probe.remove();
  return theme;
}

// Two reads of the same theme give equal (not identical) objects, and
// xterm repaints everything for any new theme object.
export function sameTheme(a: ITheme, b: ITheme): boolean {
  const keys = Object.keys(a) as ThemeColorKey[];
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}
