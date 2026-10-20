// How a command prints: one JSON document per line under --json, lines
// for a person otherwise, notes and errors on stderr. Color only on a
// terminal, never under --json, NO_COLOR or TERM=dumb.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

type Stream = {
  readonly name: string;
  readonly stream: NodeJS.WriteStream;
  // Its reader gone or the stream failed: later writes to it dropped.
  ended: boolean;
  // The drain every write held past the stream's mark waits for, one
  // per stream however many wait.
  drained: Promise<void> | null;
};
const STDOUT: Stream = {
  name: "stdout",
  stream: process.stdout,
  ended: false,
  drained: null,
};
const STDERR: Stream = {
  name: "stderr",
  stream: process.stderr,
  ended: false,
  drained: null,
};

// The first failure of a stream other than its reader going.
let failure: OutputFailed | undefined;

// What the command's output met, if a stream failed.
export const outputFailure = () => failure;

// Stdout's reader gone, which ends the command where it is.
const stdoutGone = Deferred.makeUnsafe<void>();

export const READER_GONE = Symbol("reader gone");

// The command, ended where it is once stdout's reader goes, its children
// and its cleanup run as at a Ctrl-C (main.ts): READER_GONE then.
export const untilReaderGone = Effect.raceFirst(
  Effect.as(Deferred.await(stdoutGone), READER_GONE),
);

// Once, before the command runs. A reader gone (`| head`, a pager quit
// early) ends the stream quietly, as a terminal tool does: stdout's ends
// the command too (its children and its cleanup run as at a Ctrl-C), and
// stderr's only drops what would have gone there. Any other failure of a
// stream is the command's (outputFailure). A stream closed without an
// error takes nothing more either.
export const watchStreams = () => {
  for (const each of [STDOUT, STDERR]) {
    each.stream.on("close", () => (each.ended = true));
    each.stream.on("error", (error: NodeJS.ErrnoException) => {
      each.ended = true;
      if (error.code === "EPIPE") {
        if (each === STDOUT) Deferred.doneUnsafe(stdoutGone, Exit.void);
        return;
      }
      failure ??= new OutputFailed({
        stream: each.name,
        reason: errorMessageOf(error),
      });
    });
  }
};

// The stream's next drain, or its end.
const drainOf = (to: Stream) => {
  to.drained ??= new Promise<void>((resolve) => {
    const done = () => {
      for (const event of ["drain", "error", "close"]) {
        to.stream.off(event, done);
      }
      to.drained = null;
      resolve();
    };
    for (const event of ["drain", "error", "close"]) to.stream.on(event, done);
  });
  return to.drained;
};

// A write, done once the stream has taken it: one the stream holds past
// its mark waits for its drain, so a reader slower than the command
// slows the command, where the output piled up unread in memory. Bun
// answers a write's callback before the pipe takes the bytes, so the
// drain is the signal, waited for in the same turn as the write so none
// is missed. Never fails: the engine's reporters can't, and a stream's
// failure is the command's at its end.
const write = (to: Stream, text: string) =>
  Effect.callback<void>((resume) => {
    if (to.ended || to.stream.write(text)) {
      resume(Effect.void);
      return;
    }
    void drainOf(to).then(() => resume(Effect.void));
  });

// Written as they are, since the parser runs with a console that says
// nothing (main.ts).
export const out = (line: string) => write(STDOUT, `${line}\n`);

export const emit = (doc: unknown) => out(JSON.stringify(doc));

// Written as it is: Bun's console.error paints a terminal's lines red.
export const note = (line: string) => write(STDERR, `${line}\n`);

// Bytes for stderr as they came (a script's own output).
export const toStderr = (text: string) => write(STDERR, text);

// Bytes for stderr not waited for, from a finalizer, which nothing can
// interrupt: a terminal that stopped reading can't hold the exit.
export const toStderrNow = (text: string) =>
  Effect.sync(() => {
    if (!STDERR.ended) STDERR.stream.write(text);
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
