// How a command prints: one JSON document per line under --json, lines
// for a person otherwise, notes and errors on stderr. Color only on a
// terminal, never under --json, NO_COLOR or TERM=dumb.
import * as Console from "effect/Console";
import * as Context from "effect/Context";

export class Output extends Context.Service<
  Output,
  {
    readonly json: boolean;
    readonly stdoutColor: boolean;
    readonly stderrColor: boolean;
    // The command's name, for messages that point at another command.
    readonly binaryName: string;
  }
>()("sm/cli/Output") {}

export const emit = (doc: unknown) => Console.log(JSON.stringify(doc));

export const out = (line: string) => Console.log(line);

export const note = (line: string) => Console.error(line);

const paint = (text: string, code: string, enabled: boolean) =>
  enabled && text !== "" ? `\u001b[${code}m${text}\u001b[0m` : text;

export const styles = (color: boolean) => ({
  dim: (text: string) => paint(text, "2", color),
  green: (text: string) => paint(text, "32", color),
  red: (text: string) => paint(text, "31", color),
  yellow: (text: string) => paint(text, "33", color),
  cyan: (text: string) => paint(text, "36", color),
});

// An SGR escape: ESC, `[`, its parameters, `m`.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visibleWidth = (text: string) => [...text.replace(ANSI, "")].length;

// Columns padded to their widest cell, two spaces apart, the header
// dimmed.
export function renderTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  color: boolean,
): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) =>
    Math.max(...all.map((row) => visibleWidth(row[column] ?? ""))),
  );
  const lines = all.map((row) =>
    row
      .map(
        (cell, column) =>
          cell + " ".repeat((widths[column] ?? 0) - visibleWidth(cell) + 2),
      )
      .join("")
      .trimEnd(),
  );
  return [styles(color).dim(lines[0] ?? ""), ...lines.slice(1)].join("\n");
}
