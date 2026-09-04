import type { ITheme } from "@xterm/xterm";

// xterm paints its own canvas-like surface, so it can't pick the app's
// theme up from CSS the way DOM text does. Resolve the tokens it needs
// through a probe element instead: `color: var(--token)` computed on a
// child of the console host yields whatever the active theme (light,
// dark, doubutsu) assigns, in a form xterm's color parser accepts.
// Callers re-read on every <html> class change (see ConsoleBody).
type AnsiKey =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

// xterm theme key -> the --ansi-* custom property that feeds it.
const ANSI_COLORS: ReadonlyArray<[AnsiKey, string]> = [
  ["black", "black"],
  ["red", "red"],
  ["green", "green"],
  ["yellow", "yellow"],
  ["blue", "blue"],
  ["magenta", "magenta"],
  ["cyan", "cyan"],
  ["white", "white"],
  ["brightBlack", "bright-black"],
  ["brightRed", "bright-red"],
  ["brightGreen", "bright-green"],
  ["brightYellow", "bright-yellow"],
  ["brightBlue", "bright-blue"],
  ["brightMagenta", "bright-magenta"],
  ["brightCyan", "bright-cyan"],
  ["brightWhite", "bright-white"],
];

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
  for (const [key, name] of ANSI_COLORS) {
    theme[key] = read(`var(--ansi-${name})`);
  }
  probe.remove();
  return theme;
}
