// How a command prints: one JSON document per line under --json, lines
// for a person otherwise, notes and errors on stderr. Color only on a
// terminal, never under --json, NO_COLOR or TERM=dumb.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

// A stream the command writes to failed, other than by its reader going
// (watchStreams): the command's error, said once it ends (main.ts).
class OutputFailed extends Schema.TaggedError<OutputFailed>()("OutputFailed", {
  stream: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Couldn't write to ${this.stream}: ${this.reason}`;
  }
}

type Stream = { readonly name: string; readonly stream: NodeJS.WriteStream };
const STDOUT: Stream = { name: "stdout", stream: process.stdout };
const STDERR: Stream = { name: "stderr", stream: process.stderr };

// The first failure of a stream, after which writes to it are dropped.
let failure: OutputFailed | undefined;
const fail = ({ name }: Stream, error: unknown) => {
  failure ??= new OutputFailed({ stream: name, reason: errorMessageOf(error) });
};

// What the command's output met, if a stream failed.
export const outputFailure = () => failure;

// Once, before the command runs: a reader gone (`| head`, a pager quit
// early) ends the command quietly, as a terminal tool does, with nothing
// said and nothing left to say it to; any other failure of a stream is
// the command's (outputFailure).
export const watchStreams = () => {
  for (const each of [STDOUT, STDERR]) {
    each.stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") process.exit(0);
      fail(each, error);
    });
  }
};

// A write, done once the stream has taken it: one the stream holds past
// its mark waits for its drain, so a reader slower than the command
// slows the command, where the output piled up unread in memory. Bun
// answers a write's callback before the pipe takes the bytes, so the
// drain is the signal. Never fails: the engine's reporters can't, and a
// stream's failure is the command's at its end.
const write = (to: Stream, text: string) =>
  Effect.suspend(() => {
    if (failure !== undefined && failure.stream === to.name) {
      return Effect.void;
    }
    const { stream } = to;
    if (stream.write(text)) return Effect.void;
    return Effect.callback<void>((resume) => {
      const done = () => {
        stream.off("drain", done);
        stream.off("error", done);
        resume(Effect.void);
      };
      stream.once("drain", done);
      stream.once("error", done);
      return Effect.sync(() => {
        stream.off("drain", done);
        stream.off("error", done);
      });
    });
  });

// Written as they are, since the parser runs with a console that says
// nothing (main.ts).
export const out = (line: string) => write(STDOUT, `${line}\n`);

export const emit = (doc: unknown) => out(JSON.stringify(doc));

// Written as it is: Bun's console.error paints a terminal's lines red.
export const note = (line: string) => write(STDERR, `${line}\n`);

// Bytes for stderr as they came (a script's own output).
export const toStderr = (text: string) => write(STDERR, text);

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
