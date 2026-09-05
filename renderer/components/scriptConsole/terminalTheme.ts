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
    theme[key] = getComputedStyle(probes[i]!).color;
  });
  for (const probe of probes) probe.remove();
  return theme;
}
