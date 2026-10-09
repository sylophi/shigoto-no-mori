// How a command prints: one JSON document per line under --json, lines
// for a person otherwise, notes and errors on stderr. Color only on a
// terminal, never under --json, NO_COLOR or TERM=dumb.
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class Output extends Context.Service<
  Output,
  {
    readonly json: boolean;
    readonly stdoutColor: boolean;
    readonly stderrColor: boolean;
    // The terminal's width, clamped: below 60 helps nobody, past 110 is
    // hard to scan. 80 without a terminal.
    readonly width: number;
    // The command's name, for messages that point at another command.
    readonly binaryName: string;
  }
>()("sm/cli/Output") {}

export const emit = (doc: unknown) => Console.log(JSON.stringify(doc));

export const out = (line: string) => Console.log(line);

// Written as it is: Bun's console.error paints a terminal's lines red.
export const note = (line: string) =>
  Effect.sync(() => {
    process.stderr.write(`${line}\n`);
  });

const paint = (text: string, code: string, enabled: boolean) =>
  enabled && text !== "" ? `\u001b[${code}m${text}\u001b[0m` : text;

export type Styles = ReturnType<typeof styles>;

export const styles = (color: boolean) => ({
  bold: (text: string) => paint(text, "1", color),
  dim: (text: string) => paint(text, "2", color),
  green: (text: string) => paint(text, "32", color),
  red: (text: string) => paint(text, "31", color),
  yellow: (text: string) => paint(text, "33", color),
  cyan: (text: string) => paint(text, "36", color),
});

// An SGR escape: ESC, `[`, its parameters, `m`.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visibleWidth = (text: string) => [...text.replace(ANSI, "")].length;

// Columns padded to their widest cell, two spaces apart.
export function alignRows(
  rows: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<string> {
  const widths = (rows[0] ?? []).map((_, column) =>
    Math.max(...rows.map((row) => visibleWidth(row[column] ?? ""))),
  );
  return rows.map((row) =>
    row
      .map(
        (cell, column) =>
          cell + " ".repeat((widths[column] ?? 0) - visibleWidth(cell) + 2),
      )
      .join("")
      .trimEnd(),
  );
}

// A table: its rows aligned under a dimmed header.
export function renderTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  color: boolean,
): string {
  const [head = "", ...body] = alignRows([header, ...rows]);
  return [styles(color).dim(head), ...body].join("\n");
}

// A path under the home folder, written from ~. Without a home, as is.
export const collapseHome = (home: string, path: string) =>
  home === ""
    ? path
    : path === home
      ? "~"
      : path.startsWith(`${home}/`)
        ? `~${path.slice(home.length)}`
        : path;
