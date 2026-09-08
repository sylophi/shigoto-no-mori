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
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Returns whatever
// stdout was produced before exit, falling back to empty.
export async function runLenient(
  cwd: string,
  args: string[],
  options?: RunOptions,
): Promise<string> {
  try {
    return await run(cwd, args, options);
  } catch (err) {
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
