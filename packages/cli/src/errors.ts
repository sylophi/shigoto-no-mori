// How a failed command reports and exits, the Go sm's way. An error
// says itself whether the command line was what was wrong (`usage`,
// exit 2, else 1) and which code a --json failure carries (`jsonCode`).
// Under --json the failure is a document, {ok: false, error, code?}. A
// person gets `sm: <message>` on stderr.
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as Predicate from "effect/Predicate";
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

const field = (error: unknown, name: string): unknown =>
  Predicate.isObject(error) ? Reflect.get(error, name) : undefined;

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
    const code = field(error, "jsonCode");
    if (json) {
      yield* emit(
        typeof code === "string"
          ? { ok: false, error: message, code }
          : { ok: false, error: message },
      );
    } else {
      yield* note(`${styles(stderrColor).red(`${binaryName}:`)} ${message}`);
    }
    return problems.length > 0 || field(error, "usage") === true ? 2 : 1;
  });
