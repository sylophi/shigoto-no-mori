// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

async function exec(
  args: string[],
  options: { cwd: string; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string }> {
  const start = performance.now();
  // In flight for the command's whole run, then an echo window after
  // it: the git-directory watcher checks at event time.
  const endSelfWrite = mutatesRepo(args)
    ? beginGitSelfWrite(options.cwd)
    : null;
  try {
    // LC_ALL=C pins git's messages to English: deleteAnyLocalBranch and
    // removeWorktreeForce match on stderr text, which gettext would
    // otherwise translate.
    const { env: overlay, ...rest } = options;
    const result = await execFileP("git", args, {
      env: { ...process.env, ...overlay, LC_ALL: "C" },
      ...rest,
    });
    const elapsed = Math.round(performance.now() - start);
    console.log(`[git] ${args.join(" ")} (${elapsed}ms)`);
    return { stdout: result.stdout };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    console.warn(`[git] ${args.join(" ")} FAIL (${elapsed}ms)`);
    throw err;
  } finally {
    endSelfWrite?.();
  }
}

// `env` overlays the inherited environment for this one spawn (the
// mirror's index snapshot points GIT_INDEX_FILE at a copy).
export async function run(
  cwd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const { stdout } = await exec(args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: opts.env,
  });
  return stdout;
}

// Like `run`, but tolerates non-zero exit (e.g. `git diff --no-index`,
// which exits 1 whenever there's a diff to print). Returns whatever
// stdout was produced before exit, falling back to empty.
export async function runLenient(cwd: string, args: string[]): Promise<string> {
  try {
    return await run(cwd, args);
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? "";
  }
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
