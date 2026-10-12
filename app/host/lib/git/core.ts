// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Processes from "../util/processes";

export interface RunOptions {
  // Extra variables layered over the inherited environment for this
  // one spawn. The mirror's index snapshot and the discard snapshot
  // both point GIT_INDEX_FILE at a copy, so they never touch the
  // worktree's real one.
  env?: NodeJS.ProcessEnv;
}

// Every run is buffered, so a command that never stops printing can't
// take the host process with it. This covers any status, log or ref
// output the app asks for by a wide margin.
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// A git run that failed, in git's own words: the argv would repeat
// whatever was passed (a commit message, a path list) and say nothing a
// user can act on. `stdout` is what it printed before it failed, which
// the lenient callers read. `truncated` is output past the cap, which
// is not a git failure and must never be treated as one: the output is
// a prefix of the real thing, which for a patch means whole files
// silently missing from the end of it.
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  reason: Schema.String,
  stdout: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  truncated: Schema.Boolean,
}) {
  override get message(): string {
    return this.reason;
  }
}

export const run = (cwd: string, args: string[], options: RunOptions = {}) =>
  Processes.exec("git", args, {
    cwd,
    // LC_ALL=C pins git's messages to English: deleteAnyLocalBranch
    // matches on stderr text, which gettext would otherwise translate,
    // and the errors the app relays read the same on every machine.
    env: { ...process.env, ...options.env, LC_ALL: "C" },
    maxOutputBytes: DEFAULT_MAX_BUFFER,
  }).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.mapError(
      (error) =>
        new GitError({
          reason:
            error.reason === "too-large"
              ? "git produced more output than the app can hold."
              : Processes.stderrOf(error) || error.message,
          stdout: Processes.stdoutOf(error),
          exitCode: error.exitCode,
          truncated: error.reason === "too-large",
        }),
    ),
  );

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Answers whatever
// stdout was produced before exit, falling back to empty.
//
// Truncation is the one failure it won't swallow. A run killed at the
// cap looks exactly like a diff that exited 1, and answering with the
// prefix would hand the caller a patch that parses cleanly and is
// missing every file past the cut.
export const runLenient = (cwd: string, args: string[], options?: RunOptions) =>
  run(cwd, args, options).pipe(
    Effect.catchIf(
      (error) => !error.truncated,
      (error) => Effect.succeed(error.stdout),
    ),
  );

// Pathspecs travel as argv, and a big refactor can carry enough paths
// to brush the OS arg-length limit. Callers run one git process per
// chunk.
const PATHSPEC_CHUNK = 500;

export function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += PATHSPEC_CHUNK) {
    chunks.push(items.slice(i, i + PATHSPEC_CHUNK));
  }
  return chunks;
}

// A git action the app refuses, in words for the user.
export class GitRefusal extends Schema.TaggedError<GitRefusal>()("GitRefusal", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
