// What the app types into a terminal's shell, as if the user had, in
// each syntax a terminal's shell reads (schemas/terminals.ts). A
// project's scripts run in POSIX sh on every OS (lifecycleScripts.ts),
// whatever its terminals read.
import { shellQuote } from "./lifecycleScripts.ts";
import type { ShellSyntax } from "./schemas/terminals.ts";

type Lines = {
  // A word the shell reads as `text`.
  readonly quote: (text: string) => string;
  // A path as a word, spelled as the shell shows its paths.
  readonly path: (path: string) => string;
  // A command line that makes `folder` the shell's current folder.
  readonly cd: (folder: string) => string;
  // The keys that take an idle prompt to `folder`, over whatever is half
  // typed there.
  readonly goTo: (folder: string) => string;
  // A file dropped onto the terminal, as the OS's own terminal types it.
  readonly dropped: (path: string) => string;
  // A Mac's ⌘ and ⌥ edits as the line editing keys the shell reads: to
  // the line's start and end, deleting to its start, and a word back and
  // forward.
  readonly macEditKeys: Readonly<Record<string, string>>;
};

const posixCd = (folder: string) => `cd ${shellQuote(folder)}`;

// Text in PowerShell's single quotes, where the only escape is a quote
// doubled, and it takes the curly ones for quotes too.
const powerShellQuote = (text: string) =>
  `'${text.replaceAll(/['‘-‛]/g, "$&$&")}'`;

// The engine spells a path with `/`.
const powerShellPath = (path: string) =>
  powerShellQuote(path.replaceAll("/", "\\"));

// A literal path, so brackets in it are no wildcard.
const powerShellCd = (folder: string) =>
  `Set-Location -LiteralPath ${powerShellPath(folder)}`;

export const typedLines: Readonly<Record<ShellSyntax, Lines>> = {
  posix: {
    quote: shellQuote,
    path: shellQuote,
    cd: posixCd,
    // ^U clears the line, and the leading space keeps it out of a
    // history that ignores one.
    goTo: (folder) => `\x15 ${posixCd(folder)}\r`,
    // Escaped the way a Mac terminal drops one, which a TUI that takes a
    // dropped image (Claude Code) reads back.
    dropped: (path) => path.replace(/[\s\\'"`$!#&;|*?()[\]{}<>^]/g, "\\$&"),
    macEditKeys: {
      "Meta+ArrowLeft": "\x01",
      "Meta+ArrowRight": "\x05",
      "Meta+Backspace": "\x15",
      "Alt+ArrowLeft": "\x1bb",
      "Alt+ArrowRight": "\x1bf",
    },
  },
  // As PSReadLine's default (Windows) mode reads them. Ctrl+End and
  // Ctrl+Home delete what is after and before the cursor. Escape would
  // clear the line too, but read with the keys after it, it is Alt. No
  // key keeps a line out of PSReadLine's history. Emacs or Vi mode binds
  // them otherwise and goes unmet, as a fish login shell does. Windows
  // PowerShell's PSReadLine (2.0) drops curly quotes and emoji typed in,
  // and a quoted word stays one word without them.
  powershell: {
    quote: powerShellQuote,
    path: powerShellPath,
    cd: powerShellCd,
    goTo: (folder) => `\x1b[1;5F\x1b[1;5H${powerShellCd(folder)}\r`,
    dropped: powerShellPath,
    macEditKeys: {
      "Meta+ArrowLeft": "\x1b[H",
      "Meta+ArrowRight": "\x1b[F",
      "Meta+Backspace": "\x1b[1;5H",
      "Alt+ArrowLeft": "\x1b[1;5D",
      "Alt+ArrowRight": "\x1b[1;5C",
    },
  },
};
