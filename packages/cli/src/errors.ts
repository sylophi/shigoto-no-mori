// How a failed command reports and exits, the Go sm's way: a usage
// error exits 2, anything else 1. Under --json the failure is the
// engine's error document with `ok: false`. A person gets `sm: <message>`
// on stderr.
import * as Config from "@shigomori/engine/Config";
import { errorDocument } from "@shigomori/engine/errorDocument";
import * as Worktrees from "@shigomori/engine/Worktrees";
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

// A person answered no.
export class Cancelled extends Schema.TaggedError<Cancelled>()(
  "Cancelled",
  {},
) {
  override get message(): string {
    return "Cancelled.";
  }
}

// The failures that are the caller's mistake. A ref that names nothing
// says which it is.
const isUsage = (error: unknown) =>
  error instanceof UsageError ||
  error instanceof Config.UnknownConfigKey ||
  error instanceof Config.InvalidConfigValue ||
  error instanceof Config.StructuredConfigKey ||
  (error instanceof Worktrees.TargetError && error.usage);

// Reports the failure and answers the exit code.
export const report = (error: unknown) =>
  Effect.gen(function* () {
    // The parser shows help for --help and for a command used wrongly, and
    // only the second is a failure.
    const problems = error instanceof CliError.ShowHelp ? error.errors : [];
    if (error instanceof CliError.ShowHelp && problems.length === 0) return 0;
    const { json, stderrColor, binaryName } = yield* Effect.service(Output);
    const document =
      problems.length > 0
        ? { error: problems.map((problem) => problem.message).join("\n") }
        : errorDocument(error);
    if (json) {
      yield* emit({ ok: false, ...document });
    } else {
      yield* note(
        `${styles(stderrColor).red(`${binaryName}:`)} ${document.error}`,
      );
    }
    return problems.length > 0 || isUsage(error) ? 2 : 1;
  });
