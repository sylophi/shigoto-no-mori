// How a failed command reports and exits, the Go sm's way: a usage
// error exits 2, anything else 1. Under --json the failure is a document,
// {ok: false, error}. A person gets `sm: <message>` on stderr.
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as Predicate from "effect/Predicate";
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

// The engine's failures that are the caller's mistake, by tag.
const USAGE = new Set([
  "UsageError",
  "UnknownConfigKey",
  "InvalidConfigValue",
  "StructuredConfigKey",
]);

// An Effect error's tag, read without naming the field.
const tagOf = (error: unknown) => {
  const tag: unknown = Predicate.isObject(error)
    ? Reflect.get(error, "_tag")
    : undefined;
  return typeof tag === "string" ? tag : undefined;
};

// Reports the failure and answers the exit code.
export const report = (error: unknown) =>
  Effect.gen(function* () {
    const tag = tagOf(error);
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
    if (json) {
      yield* emit({ ok: false, error: message });
    } else {
      yield* note(`${styles(stderrColor).red(`${binaryName}:`)} ${message}`);
    }
    return problems.length > 0 || (tag !== undefined && USAGE.has(tag)) ? 2 : 1;
  });
