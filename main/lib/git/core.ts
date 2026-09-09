// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface RunOptions {
  // Extra variables layered over the inherited environment. The one
  // user so far is the discard snapshot, which points GIT_INDEX_FILE at
  // a scratch index so it never touches the worktree's real one.
  env?: Record<string, string>;
  // Output cap for this run, over DEFAULT_MAX_BUFFER. Only the patch
  // reads raise it -- see PATCH_MAX_BUFFER.
  maxBuffer?: number;
}

// Every run is buffered, so a command that never stops printing can't
// take the main process with it. This covers any status, log or ref
// output the app asks for by a wide margin.
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// A patch is the one output whose size the user decides rather than the
// app: one regenerated lockfile or checked-in bundle in the working
// tree runs to tens of megabytes on its own. Sized to swallow that,
// because the alternative isn't a smaller patch -- it's a wrong one
// (see below).
export const PATCH_MAX_BUFFER = 64 * 1024 * 1024;

// Node kills the child once its output passes maxBuffer and reports the
// truncated stdout alongside the error. That is not a git failure and
// must never be treated as one: the output is a prefix of the real
// thing, which for a patch means whole files silently missing from the
// end of it.
function isTruncated(err: unknown): boolean {
  return (
    (err as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

async function exec(
  args: string[],
  options: { cwd: string; maxBuffer?: number } & RunOptions,
): Promise<{ stdout: string }> {
  const start = performance.now();
  const { env, ...execOptions } = options;
  try {
    // LC_ALL=C pins git's messages to English: deleteAnyLocalBranch and
    // removeWorktreeForce match on stderr text, which gettext would
    // otherwise translate.
    const result = await execFileP("git", args, {
      env: { ...process.env, LC_ALL: "C", ...env },
      ...execOptions,
    });
    const elapsed = Math.round(performance.now() - start);
    console.log(`[git] ${args.join(" ")} (${elapsed}ms)`);
    return { stdout: result.stdout };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    console.warn(`[git] ${args.join(" ")} FAIL (${elapsed}ms)`);
    // execFile's message is "Command failed: git <argv>\n<stderr>". The
    // argv repeats whatever was passed (a commit message, a path list)
    // and says nothing a user can act on. Git's own words do. Keep the
    // stdout the lenient callers read, and the rest of the error.
    const failure = err as Error & { stdout?: string; stderr?: string };
    if (isTruncated(err)) {
      failure.message = "git produced more output than the app can hold.";
      throw failure;
    }
    const stderr = failure.stderr?.trim();
    if (stderr) failure.message = stderr;
    throw failure;
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
// Truncation is the one failure it won't swallow. Git's exit code says
// nothing about whether the output is complete, so a run killed at
// maxBuffer looks exactly like a diff that exited 1 -- and answering
// with the prefix hands the caller a patch that parses cleanly and is
// missing every file past the cut. Loudly wrong beats quietly wrong.
export async function runLenient(
  cwd: string,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  try {
    return await run(cwd, args, options);
  } catch (err) {
    if (isTruncated(err)) throw err;
    return (err as { stdout?: string }).stdout ?? "";
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
