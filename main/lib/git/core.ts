// Single chokepoint for every git invocation. Other modules in this
// folder call `run` / `runLenient`; nothing else in the codebase should
// shell out to git directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function exec(
  args: string[],
  options: { cwd: string; maxBuffer?: number },
): Promise<{ stdout: string }> {
  const start = performance.now();
  try {
    // windowsHide: git.exe is a console-subsystem binary; without this,
    // every spawn from the windowless packaged app flashes a conhost
    // window on Windows -- and this chokepoint runs on a 60s sweep.
    // LC_ALL=C pins git's messages to English: deleteAnyLocalBranch and
    // removeWorktreeForce match on stderr text, which gettext would
    // otherwise translate.
    const result = await execFileP("git", args, {
      windowsHide: true,
      env: { ...process.env, LC_ALL: "C" },
      ...options,
    });
    const elapsed = Math.round(performance.now() - start);
    console.log(`[git] ${args.join(" ")} (${elapsed}ms)`);
    return { stdout: result.stdout };
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    console.warn(`[git] ${args.join(" ")} FAIL (${elapsed}ms)`);
    throw err;
  }
}

export async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(args, { cwd, maxBuffer: 10 * 1024 * 1024 });
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

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec(["rev-parse", "--git-dir"], { cwd: path });
    return true;
  } catch {
    return false;
  }
}
