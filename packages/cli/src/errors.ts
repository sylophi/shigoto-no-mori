// How a failed command reports and exits, the Go sm's way: a usage
// error exits 2, anything else 1. Under --json the failure is a document,
// {ok: false, error}. A person gets `sm: <message>` on stderr.
import * as Effect from "effect/Effect";
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

// The failures that are the caller's mistake, by tag: the CLI parser's
// and the engine's.
const USAGE = new Set([
  "UsageError",
  "UnrecognizedOption",
  "DuplicateOption",
  "MissingOption",
  "MissingArgument",
  "UnexpectedArgument",
  "InvalidValue",
  "UnknownSubcommand",
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

// Reports the failure and answers the exit code. Help the parser shows
// is not a failure.
export const report = (error: unknown) =>
  Effect.gen(function* () {
    const tag = tagOf(error);
    if (tag === "ShowHelp") return 0;
    const { json, stderrColor, binaryName } = yield* Effect.service(Output);
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      yield* emit({ ok: false, error: message });
    } else {
      yield* note(`${styles(stderrColor).red(`${binaryName}:`)} ${message}`);
    }
    return tag !== undefined && USAGE.has(tag) ? 2 : 1;
  });
