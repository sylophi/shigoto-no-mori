// How a failed command reports and exits, the Go sm's way: a usage
// error exits 2, anything else 1. Under --json the failure is the
// engine's error document with `ok: false`. A person gets `sm: <message>`
// on stderr.
import { constants } from "node:os";
import { errorDocument, isUsage } from "@shigomori/engine/errorDocument";
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as Schema from "effect/Schema";
import { emit, note, Output, styles } from "./output.ts";

// A command used the wrong way, caught by the terminal itself.
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  problem: Schema.String,
}) {
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

// A person answered no.
export class Cancelled extends Schema.TaggedError<Cancelled>()(
  "Cancelled",
  {},
) {
  override get message(): string {
    return "Cancelled.";
  }
}

// The subcommands a namespace takes, which an unknown one is told.
const NAMESPACE_USAGE: Readonly<Record<string, string>> = {
  projects: "projects <list|add|remove|relocate|reorder|config|icon> [args]",
  "projects config":
    "projects config <list|get|set|unset|edit|launcher|carryover> [args]",
  config: "config <list|get|set|unset|edit|launcher> [args]",
  shell: "shell <install|uninstall|status|init>",
  agents: "agents <bind|unbind|idle|resume|install|uninstall|status> [args]",
};

// What the parser found wrong, in the Go sm's words. `path` is the
// command's names after the binary's, and `usageOf` its usage line.
const usageProblem = (
  problem: CliError.NonShowHelpErrors,
  path: ReadonlyArray<string>,
  binaryName: string,
  usageOf: (path: ReadonlyArray<string>) => string | undefined,
): string => {
  if (problem instanceof CliError.UnrecognizedOption) {
    return `Unknown option "${problem.option}".`;
  }
  if (problem instanceof CliError.UnknownSubcommand) {
    const parent = (problem.parent ?? []).slice(1).join(" ");
    const usage = NAMESPACE_USAGE[parent];
    return usage === undefined
      ? `Unknown command "${problem.subcommand}". Run \`${binaryName} --help\`.`
      : `Unknown subcommand "${problem.subcommand}". Usage: ${binaryName} ${usage}`;
  }
  if (
    problem instanceof CliError.InvalidValue &&
    problem.kind === "flag" &&
    problem.value === ""
  ) {
    return `Option "--${problem.option}" requires a value.`;
  }
  return usageOf(path) ?? problem.message;
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
    // The first problem, as Go's parser stopped at it.
    const [problem] = problems;
    const document =
      problem !== undefined
        ? { error: usageProblem(problem, path, binaryName, usageOf) }
        : errorDocument(error);
    if (json) {
      yield* emit({ ok: false, ...document });
    } else {
      yield* note(
        `${styles(stderrColor).red(`${binaryName}:`)} ${document.error}`,
      );
    }
    return problem !== undefined ||
      error instanceof UsageError ||
      isUsage(error)
      ? 2
      : 1;
  });
