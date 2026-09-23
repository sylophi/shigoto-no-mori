// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Schema } from "effect";
import { beginGitSelfWrite } from "../util/selfWrite";

const execFileP = promisify(execFile);

// Subcommands that never move refs, HEAD or a worktree entry, so they
// need no self-write mark: these run on every listing (a status per
// worktree, a branch list per project), and marking them would let
// the app's own refetch swallow the very external commit it should
// surface. Everything else (fetch, checkout, commit, merge, rebase,
// reset, branch and worktree mutations, push, update-ref) marks the
// window, and an unknown subcommand marks it too, the safe direction
// (a spurious mark costs one dropped ping for a second, a missed mark
// costs one redundant sweep). The list forms below are the ones the
// app actually runs.
const READ_ONLY_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "check-ignore",
  "count-objects",
  "describe",
  "diff",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "merge-tree",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
]);

function mutatesRepo(args: string[]): boolean {
  // The subcommand is the first argument that is not a global option
  // (`-c key=value`, `-C dir`, `--no-pager`).
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-c" || arg === "-C") {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === undefined) return false;
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) return false;
  // The list forms of otherwise-mutating subcommands.
  if (subcommand === "worktree") return rest[0] !== "list";
  if (subcommand === "branch") {
    return !rest.some(
      (arg) =>
        arg === "--list" ||
        arg === "-a" ||
        arg === "--all" ||
        arg === "--show-current" ||
        arg.startsWith("--format") ||
        arg.startsWith("--merged") ||
        arg.startsWith("--no-merged") ||
        arg.startsWith("--contains"),
    );
  }
  if (subcommand === "remote") {
    return rest.length > 0 && rest[0] !== "-v" && rest[0] !== "get-url";
  }
  if (subcommand === "stash") return rest[0] !== "list";
  if (subcommand === "tag")
    return !rest.some((arg) => arg === "-l" || arg === "--list");
  if (subcommand === "config")
    return !rest.some((arg) => arg.startsWith("--get"));
  if (subcommand === "symbolic-ref")
    return rest.filter((arg) => !arg.startsWith("-")).length > 1;
  return true;
}

export interface RunOptions {
  // Extra variables layered over the inherited environment for this
  // one spawn. The mirror's index snapshot and the discard snapshot
  // both point GIT_INDEX_FILE at a copy, so they never touch the
  // worktree's real one.
  env?: NodeJS.ProcessEnv;
  // Output cap for this run, over DEFAULT_MAX_BUFFER. Only the patch
  // reads raise it (see PATCH_MAX_BUFFER).
  maxBuffer?: number;
}

// Every run is buffered, so a command that never stops printing can't
// take the host process with it. This covers any status, log or ref
// output the app asks for by a wide margin.
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// A patch is the one output whose size the user decides rather than the
// app: one regenerated lockfile or checked-in bundle runs to tens of
// megabytes on its own. Sized to swallow that, because the alternative
// isn't a smaller patch but a wrong one (see GitOutputTruncated).
export const PATCH_MAX_BUFFER = 64 * 1024 * 1024;

// git ran and failed: a non-zero exit, or a kill by signal (exitCode
// null). Callers that need to tell failures apart read `stderr` or
// `exitCode`, never the message. A failure to start git at all (no
// binary, a missing cwd) is not one of these: it stays Node's own
// errno error, whose "spawn git ENOENT" is the useful part.
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  stderr: Schema.String,
  // What git printed before it failed. runLenient answers with it.
  stdout: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
}) {
  // Git's own words. execFile's message is "Command failed: git
  // <argv>\n<stderr>", and the argv repeats whatever was passed (a
  // commit message, a path list, a clone URL) and says nothing a user
  // can act on, so it is never part of this.
  override get message(): string {
    const stderr = this.stderr.trim();
    if (stderr) return stderr;
    return this.exitCode === null
      ? "git was stopped before it finished."
      : `git exited with code ${this.exitCode}.`;
  }
}

// Node kills the child once its output passes maxBuffer and reports the
// truncated stdout alongside the error. That is not a git failure and
// must never be treated as one: the output is a prefix of the real
// thing, which for a patch means whole files silently missing from the
// end of it.
export class GitOutputTruncated extends Schema.TaggedError<GitOutputTruncated>()(
  "GitOutputTruncated",
  {},
) {
  override get message(): string {
    return "git produced more output than the app can hold.";
  }
}

// execFile's rejection, as the promisified form hands it over.
interface ExecFileFailure {
  code?: unknown;
  signal?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

// The typed form of an execFile rejection, or the rejection itself when
// git never ran. A numeric `code` is git's exit status; a string one is
// an errno from the spawn or Node's maxBuffer kill; neither with a
// signal set is a kill.
function gitFailure(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return err;
  const { code, signal, stdout, stderr } = err as ExecFileFailure;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GitOutputTruncated();
  }
  if (typeof code !== "number" && typeof signal !== "string") return err;
  return new GitError({
    stderr: asText(stderr),
    stdout: asText(stdout),
    exitCode: typeof code === "number" ? code : null,
  });
}

async function exec(
  args: string[],
  options: { cwd: string } & RunOptions,
): Promise<{ stdout: string }> {
  // In flight for the command's whole run, then an echo window after
  // it: the git-directory watcher checks at event time.
  const endSelfWrite = mutatesRepo(args)
    ? beginGitSelfWrite(options.cwd)
    : null;
  const { env: overlay, ...execOptions } = options;
  try {
    // LC_ALL=C pins git's messages to English: deleteAnyLocalBranch and
    // removeWorktreeForce match on stderr text, which gettext would
    // otherwise translate.
    const result = await execFileP("git", args, {
      env: { ...process.env, ...overlay, LC_ALL: "C" },
      ...execOptions,
    });
    return { stdout: result.stdout };
  } catch (err) {
    throw gitFailure(err);
  } finally {
    endSelfWrite?.();
  }
}

export async function run(
  cwd: string,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  const { stdout } = await exec(args, {
    cwd,
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...options,
  });
  return stdout;
}

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Returns whatever
// stdout was produced before exit, falling back to empty.
//
// Truncation is the one failure it won't swallow. A run killed at
// maxBuffer looks exactly like a diff that exited 1, and answering with
// the prefix would hand the caller a patch that parses cleanly and is
// missing every file past the cut.
export async function runLenient(
  cwd: string,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  try {
    return await run(cwd, args, options);
  } catch (err) {
    if (err instanceof GitError) return err.stdout;
    if (err instanceof GitOutputTruncated) throw err;
    return "";
  }
}

// Pathspecs travel as argv, and a big refactor can carry enough paths
// to brush the OS arg-length limit. Callers run one git process per
// chunk.
export const PATHSPEC_CHUNK = 500;

export function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += PATHSPEC_CHUNK) {
    chunks.push(items.slice(i, i + PATHSPEC_CHUNK));
  }
  return chunks;
}

// For `-z` output: NUL-separated records, with a trailing NUL that
// would otherwise yield a phantom empty entry.
export function splitZ(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec(["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}
