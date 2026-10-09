// The fixture the CLI-driving proofs (control.mts, mirror.mts,
// sync-transfer.mts) share: one sandbox holding the data dir and the
// repos, the terminal sm on it (built once across proofs, see
// smBinary.mts) beside the engine the host runs on, and git wrappers
// over the scrubbed environment.
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCliRunner, scrubProcessGitEnv } from "./checkKit.mts";
import {
  addProject,
  builtSm,
  smBinaryPath,
  type WiredHostCli,
  wireHostCli,
} from "./smBinary.mts";

const execFileP = promisify(execFile);

// execFile's message is just "Command failed". The reason is on
// stderr.
function gitFailure(cwd: string, args: string[], error: unknown): Error {
  const failure = error as Error & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  return new Error(
    `git ${args.join(" ")} in ${cwd} failed: ${failure.stderr || failure.stdout || failure.message}`,
    { cause: error },
  );
}

// `prefix` names the temp dir, `extraSmEnv` lands on top of the env
// the sm binary runs under.
export function cliSandbox(prefix: string, extraSmEnv: NodeJS.ProcessEnv = {}) {
  // Sandbox: everything (data dir, repos, the built binary) under one
  // temp tree. realpath because worktree ids derive from git's resolved
  // paths (/var/folders is a symlink on macOS).
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dataDir = join(sandbox, "data");
  const smBinary = smBinaryPath();

  // The kit's scrub (no inherited GIT_*, config pinned) applied to
  // process.env itself rather than a copy: the host modules under test
  // run git in THIS process (host/lib/git/core.ts reads process.env,
  // and the slice-C pull orchestration drives the app's OWN git layer),
  // so a lefthook-exported GIT_DIR would otherwise point them at the
  // real repository. Plus the locale and the fixture identity, pinned
  // so commit-tree in `sm dirty capture` never depends on the
  // machine's git config.
  scrubProcessGitEnv({
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  });
  const baseEnv = { ...process.env };
  const smEnv = { ...baseEnv, SHIGOMORI_DATA_DIR: dataDir, ...extraSmEnv };

  const gitOpts = (cwd: string) => ({
    cwd,
    env: baseEnv,
    maxBuffer: 16 * 1024 * 1024,
  });

  async function git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileP("git", args, {
        ...gitOpts(cwd),
        encoding: "utf8",
      });
    } catch (error) {
      throw gitFailure(cwd, args, error);
    }
  }

  // git's stdout as raw bytes, for output that is not text (a blob).
  async function gitBytes(cwd: string, args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFileP("git", args, {
        ...gitOpts(cwd),
        encoding: "buffer",
      });
      return stdout;
    } catch (error) {
      throw gitFailure(cwd, args, error);
    }
  }

  async function gitOut(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await git(cwd, args);
    return stdout.trim();
  }

  // Write one file, stage everything, commit.
  async function commitFile(
    dir: string,
    file: string,
    content: string | NodeJS.ArrayBufferView,
    message: string,
  ): Promise<void> {
    writeFileSync(join(dir, file), content);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", message]);
  }

  // A linked worktree at <sandbox>/<name> on a new branch. With a
  // `file`, it also commits that file (by default the branch name as
  // both its content and the message). Returns the worktree's path.
  async function addWorktree(
    repo: string,
    name: string,
    branch: string,
    file?: string,
    content = `${branch}\n`,
    message = branch,
  ): Promise<string> {
    const path = join(sandbox, name);
    await git(repo, ["worktree", "add", "-q", "-b", branch, path]);
    if (file !== undefined) await commitFile(path, file, content, message);
    return path;
  }

  // Keeps git's automatic gc and maintenance off in a fixture repo.
  async function disableAutoGc(repo: string): Promise<void> {
    await git(repo, ["config", "gc.auto", "0"]);
    await git(repo, ["config", "maintenance.auto", "false"]);
  }

  // The terminal binary, on the same data dir.
  const { runCli, sm } = createCliRunner(smBinary, smEnv);
  let wired: WiredHostCli | undefined;

  return {
    sandbox,
    dataDir,
    smBinary,
    baseEnv,
    smEnv,
    git,
    gitBytes,
    gitOut,
    commitFile,
    addWorktree,
    disableAutoGc,
    runCli,
    sm,
    // Builds the terminal binary, unless an earlier proof has.
    buildSm: async () => {
      builtSm();
    },
    // Points the host at the sandbox's data dir and brings the engine
    // up on it, which `remove` closes.
    async useCli(): Promise<void> {
      wired = await wireHostCli(dataDir, extraSmEnv);
    },
    // Registers a repo as a project through the terminal binary,
    // returning its id.
    async projectIdOf(path: string): Promise<string> {
      return (await addProject(sm, path)).id;
    },
    remove: async () => {
      await wired?.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}
