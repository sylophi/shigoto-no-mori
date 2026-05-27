import Anser, { type AnserJsonEntry } from "anser";

// Combine chunks, collapse \r progress-bar overwrites within each line
// (the last segment wins), then parse ANSI/SGR into colored + styled
// tokens. \r-collapse runs before parsing so progress indicators that
// don't change attributes mid-bar still show as one final line.
export function parseOutput(chunks: string[]): AnserJsonEntry[] {
  if (chunks.length === 0) return [];
  const collapsed = chunks
    .join("")
    .split("\n")
    .map((line) =>
      line.includes("\r") ? (line.split("\r").pop() ?? line) : line,
    )
    .join("\n");
  return Anser.ansiToJson(collapsed, {
    use_classes: true,
    remove_empty: true,
  });
}

// http(s) only — file:/mailto:/data: would surprise the user if we
// routed them through openExternal. Trailing `.,;:!?)>]` is stripped
// after the match so prose like "see http://x." doesn't swallow the
// period.
export interface UrlRange {
  start: number;
  end: number;
  url: string;
}

export function findUrlRanges(text: string): UrlRange[] {
  if (!text.includes("http")) return [];
  const out: UrlRange[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"']+/g)) {
    const url = m[0].replace(/[.,;:!?)>\]]+$/, "");
    if (url.length === 0) continue;
    out.push({ start: m.index, end: m.index + url.length, url });
  }
  return out;
}

const PALETTE_RE = /^ansi-palette-(\d+)$/;

export function resolveAnsiInline(
  name: string,
  truecolor: string | null,
): string | null {
  if (name === "ansi-truecolor" && truecolor) return `rgb(${truecolor})`;
  const m = PALETTE_RE.exec(name);
  if (!m) return null;
  const idx = Number(m[1]);
  if (idx < 16 || idx > 255) return null;
  return PALETTE_256[idx - 16];
}

// 256-color palette covering indices 16-255 (0-15 hit the named CSS
// classes). 16-231: 6x6x6 cube; 232-255: 24-step grayscale. Standard
// values match what xterm and modern terminal emulators use.
const PALETTE_256: string[] = (() => {
  const cube = [0, 95, 135, 175, 215, 255];
  const out: string[] = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        out.push(`rgb(${cube[r]}, ${cube[g]}, ${cube[b]})`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(`rgb(${v}, ${v}, ${v})`);
  }
  return out;
})();
