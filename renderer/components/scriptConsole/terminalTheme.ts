import type { ITheme } from "@xterm/xterm";

// xterm paints its own canvas-like surface, so it can't pick the app's
// theme up from CSS the way DOM text does. Resolve the tokens it needs
// through a probe element instead: `color: var(--token)` computed on a
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

export function readTerminalTheme(host: HTMLElement): ITheme {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.append(probe);
  const read = (expr: string): string => {
    probe.style.color = expr;
    return getComputedStyle(probe).color;
  };
  const theme: ITheme = {
    background: read("var(--background)"),
    foreground: read("var(--foreground)"),
    cursor: read("var(--foreground)"),
    cursorAccent: read("var(--background)"),
    selectionBackground: read(
      "color-mix(in oklab, var(--foreground) 22%, transparent)",
    ),
  };
  for (const base of ANSI_BASES) {
    theme[base] = read(`var(--ansi-${base})`);
    const bright =
      `bright${base[0]!.toUpperCase()}${base.slice(1)}` as `bright${Capitalize<AnsiBase>}`;
    theme[bright] = read(`var(--ansi-bright-${base})`);
  }
  probe.remove();
  return theme;
}
