// How a failed command reports and exits: a usage error exits 2, an
// `ExitCode` its own code, a program handed the terminal that a signal
// killed 128+n, and anything else 1. `ExitCode` and a killed program
// say nothing more; any other failure is, under --json, the engine's
// error document with `ok: false`, and to a person `sm: <message>` on
// stderr.
import { constants } from "node:os";
import {
  type ErrorDocument,
  errorDocument,
  isUsage,
  withHint,
} from "@shigomori/engine/errorDocument";
import { storeErrorOf } from "@shigomori/engine/storeErrors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as Schema from "effect/Schema";
import { emit, note, Output, styles } from "./output.ts";

// A command used the wrong way, caught by the terminal itself.
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  problem: Schema.String,
}) {
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    return this.problem;
  }
}

// A command that has said all it has to and ends with `code`.
export class ExitCode extends Schema.TaggedError<ExitCode>()("ExitCode", {
  code: Schema.Int,
}) {}

// The signals a program crashes with.
const CRASHES = new Set([
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGABRT",
  "SIGTRAP",
  "SIGSYS",
]);

// A command whose program was killed by `signal`. sm dies of the same
// signal (main.ts), so whoever started it sees what running the program
// themselves would have shown, a shell's 128+n among it. A crash signal
// is only reported as 128+n: raising it on sm would read as sm crashing,
// with a crash report of its own.
export class Killed extends Schema.TaggedError<Killed>()("Killed", {
  signal: Schema.String,
}) {
  get raised(): boolean {
    return !CRASHES.has(this.signal);
  }
}

// `effect`, left undone where it would write to a 2.x data dir the app
// has yet to migrate (engine.ts): what a hook or a command's
// bookkeeping does on the side, which v2's files don't take.
export const unlessUnmigrated = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCauseIf(
      (cause) => storeErrorOf(Cause.squash(cause))?.category === "unmigrated",
      () => Effect.void,
    ),
  );

// A person answered no.
export class Cancelled extends Schema.TaggedError<Cancelled>()(
  "Cancelled",
  {},
) {
  override get message(): string {
    return "Cancelled.";
  }
}

// The subcommands a namespace takes, which an unknown one is told, as
// the help documents them.
export const NAMESPACE_USAGE: Readonly<Record<string, string>> = {
  projects: "projects <list|icon|add|remove|relocate|reorder|config> [args]",
  "projects config":
    "projects config <list|get|set|unset|edit|read|launcher|carryover> [args]",
  config: "config <list|read|get|set|unset|launcher|edit> [args]",
  shell: "shell <install|uninstall|status|init>",
  agents:
    "agents <install|uninstall|status|bind|unbind|idle|resume|event> [args]",
};

// A word that names no command where one was due. `path` is the
// namespace's names after the binary's.
export const unknownCommand = (
  path: ReadonlyArray<string>,
  word: string,
  binaryName: string,
) => {
  const usage = NAMESPACE_USAGE[path.join(" ")];
  return usage === undefined
    ? `Unknown command "${word}". Run \`${binaryName} --help\`.`
    : `Unknown subcommand "${word}". Usage: ${binaryName} ${usage}`;
};

// Reports the failure and answers the exit code. `usageOf` is a
// command's usage line, for a command line the parser refused.
export const report = (
  error: unknown,
  usageOf: (path: ReadonlyArray<string>) => string | undefined,
) =>
  Effect.gen(function* () {
    const problems = error instanceof CliError.ShowHelp ? error.errors : [];
    if (error instanceof ExitCode) return error.code;
    if (error instanceof Killed) {
      return 128 + (constants.signals[error.signal as NodeJS.Signals] ?? 0);
    }
    const { json, stderrColor, binaryName } = yield* Effect.service(Output);
    const path =
      error instanceof CliError.ShowHelp ? error.commandPath.slice(1) : [];
    const [problem] = problems;
    const document: ErrorDocument =
      problem !== undefined
        ? { error: usageOf(path) ?? problem.message }
        : errorDocument(error);
    if (json) {
      yield* emit({ ok: false, ...document });
    } else {
      yield* note(
        `${styles(stderrColor).red(`${binaryName}:`)} ${withHint(document.error, document.hint)}`,
      );
    }
    return problem !== undefined || isUsage(error) ? 2 : 1;
  });
