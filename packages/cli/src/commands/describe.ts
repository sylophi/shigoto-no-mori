// sm [worktrees] describe [<worktree>] [-t <title>] [-d <text> |
// --description-file <path|->]: a worktree's title and description,
// set or shown. An open pull request's own take their place.
import { readFileSync } from "node:fs";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { resolveWorktree, worktreeFlags } from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";

// The description file couldn't be read.
class UnreadableDescription extends Schema.TaggedError<UnreadableDescription>()(
  "UnreadableDescription",
  { problem: Schema.String },
) {
  override get message(): string {
    return `Couldn't read the description: ${this.problem}`;
  }
}

// Go's words for why a file didn't open.
const why = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound")
    ? "no such file or directory"
    : Predicate.isTagged(error.reason, "PermissionDenied")
      ? "permission denied"
      : error.message;

// The text a description file holds, stdin for "-".
const readDescription = (file: string) =>
  file === "-"
    ? Effect.try({
        try: () => readFileSync(0, "utf8"),
        catch: (cause) =>
          new UnreadableDescription({
            problem: `read stdin: ${String(cause)}`,
          }),
      })
    : Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
        fs.readFileString(file).pipe(
          Effect.mapError(
            (error) =>
              new UnreadableDescription({
                problem: `open ${file}: ${why(error)}`,
              }),
          ),
        ),
      );

export const describe = Command.make(
  "describe",
  {
    ...worktreeFlags,
    names: Argument.String("worktree").pipe(Argument.variadic()),
    title: Flag.String("title").pipe(Flag.withAlias("t"), Flag.optional),
    description: Flag.String("description").pipe(
      Flag.withAlias("d"),
      Flag.optional,
    ),
    descriptionFile: Flag.String("description-file").pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const { json, stdoutColor, stderrColor, binaryName } =
        yield* Effect.service(Output);
      if (input.names.length > 1) {
        return yield* new UsageError({
          problem: `Usage: ${binaryName} worktrees describe [<name>] [-t|--title <title>] [-d|--description <text> | --description-file <path|->]`,
        });
      }
      if (
        Option.isSome(input.description) &&
        Option.isSome(input.descriptionFile)
      ) {
        return yield* new UsageError({
          problem:
            "Give the description with -d or --description-file, not both.",
        });
      }
      const description = Option.isSome(input.descriptionFile)
        ? Option.some(yield* readDescription(input.descriptionFile.value))
        : input.description;
      const located = (yield* resolveWorktree({
        ...input,
        ref: Option.fromNullishOr(input.names[0]),
      })).located;
      const worktrees = yield* Worktrees.Worktrees;
      // Said on stderr, so the answer stands without it.
      const unavailable = (reason: string) =>
        note(
          styles(stderrColor).dim(
            `Couldn't check for a pull request (${reason}).`,
          ),
        );

      if (Option.isNone(input.title) && Option.isNone(description)) {
        const view = yield* worktrees.description(located);
        if (view.pullRequestUnavailable !== undefined) {
          yield* unavailable(view.pullRequestUnavailable);
        }
        if (json) {
          return yield* emit({
            ok: true,
            title: view.title,
            description: view.description,
            pullRequest: view.pullRequest,
          });
        }
        const pr = view.pullRequest;
        if (pr !== null) {
          yield* note(
            styles(stderrColor).dim(`From open PR #${pr.number} (${pr.url}):`),
          );
        }
        const title = pr === null ? view.title : pr.title;
        const text = pr === null ? view.description : pr.body.trim();
        if (title === "" && text === "") {
          return yield* out(
            `${located.worktree.name} has no title or description`,
          );
        }
        yield* out(title === "" ? "(no title)" : title);
        if (text !== "") yield* out(`\n${text}`);
        return;
      }

      const row = yield* worktrees.describe(
        located,
        {
          ...(Option.isSome(input.title) ? { title: input.title.value } : {}),
          ...(Option.isSome(description)
            ? { description: description.value }
            : {}),
        },
        unavailable,
      );
      yield* json
        ? emit({ ok: true, worktree: row })
        : out(
            styles(stdoutColor).green(
              `described ${row.name}: ${row.title === undefined || row.title === "" ? "(no title)" : row.title}`,
            ),
          );
    }),
).pipe(
  Command.withDescription("Set or show a worktree's title and description"),
);
