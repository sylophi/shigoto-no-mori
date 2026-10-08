// How a failed command reports and exits, the Go sm's way: a usage
// error exits 2, anything else 1. Under --json the failure is a
// document, {ok: false, error, code?}, where the code names a failure
// the app maps without reading prose. A person gets `sm: <message>` on
// stderr.
import * as Config from "@shigomori/engine/Config";
import * as Registry from "@shigomori/engine/Registry";
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

// The failures that are the caller's mistake. A ref that names nothing
// says which it is.
const isUsage = (error: unknown) =>
  error instanceof UsageError ||
  error instanceof Config.UnknownConfigKey ||
  error instanceof Config.InvalidConfigValue ||
  error instanceof Config.StructuredConfigKey ||
  (error instanceof Worktrees.TargetError && error.usage);

const codeOf = (error: unknown) =>
  error instanceof Registry.UnknownProject ? "unknown-project" : undefined;

// Reports the failure and answers the exit code.
export const report = (error: unknown) =>
  Effect.gen(function* () {
    // The parser shows help for --help and for a command used wrongly, and
    // only the second is a failure.
    const problems = error instanceof CliError.ShowHelp ? error.errors : [];
    if (error instanceof CliError.ShowHelp && problems.length === 0) return 0;
    const { json, stderrColor, binaryName } = yield* Effect.service(Output);
    const message =
      problems.length > 0
        ? problems.map((problem) => problem.message).join("\n")
        : error instanceof Error
          ? error.message
          : String(error);
    const code = codeOf(error);
    if (json) {
      yield* emit(
        code === undefined
          ? { ok: false, error: message }
          : { ok: false, error: message, code },
      );
    } else {
      yield* note(`${styles(stderrColor).red(`${binaryName}:`)} ${message}`);
    }
    return problems.length > 0 || isUsage(error) ? 2 : 1;
  });
