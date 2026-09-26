// The fixture the CLI-driving proofs (control.mjs, mirror.mjs,
// sync-transfer.mjs) share: one sandbox holding the data dir, the
// repos and the sm binary built from cli/, git wrappers over the
// scrubbed environment, and the real CLI runner seam. Runs under
// register-ts-alias so the host imports resolve.
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { initDataDirAt } from "@host/lib/util/paths";
import {
  cliFailureMessage,
  createCliRunner,
  repoRoot,
  scrubProcessGitEnv,
} from "./checkKit.mjs";

const execFileP = promisify(execFile);
const cliDir = join(repoRoot, "cli");

// `prefix` names the temp dir, `extraSmEnv` lands on top of the env
// the sm binary runs under.
export function cliSandbox(prefix, extraSmEnv = {}) {
  // Sandbox: everything (data dir, repos, the built binary) under one
  // temp tree. realpath because worktree ids derive from git's resolved
  // paths (/var/folders is a symlink on macOS).
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dataDir = join(sandbox, "data");
  const smBinary = join(sandbox, "sm");

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

  async function git(cwd, args, opts = {}) {
    try {
      return await execFileP("git", args, {
        cwd,
        env: baseEnv,
        maxBuffer: 16 * 1024 * 1024,
        ...opts,
      });
    } catch (error) {
      // execFile's message is just "Command failed". The reason is on
      // stderr.
      throw new Error(
        `git ${args.join(" ")} in ${cwd} failed: ${error.stderr || error.stdout || error.message}`,
        { cause: error },
      );
    }
  }

  async function gitOut(cwd, ...args) {
    const { stdout } = await git(cwd, args);
    return stdout.trim();
  }

  // Write one file, stage everything, commit.
  async function commitFile(dir, file, content, message) {
    writeFileSync(join(dir, file), content);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", message]);
  }

  // A linked worktree at <sandbox>/<name> on a new branch. With a
  // `file`, it also commits that file (by default the branch name as
  // both its content and the message). Returns the worktree's path.
  async function addWorktree(
    repo,
    name,
    branch,
    file,
    content = `${branch}\n`,
    message = branch,
  ) {
    const path = join(sandbox, name);
    await git(repo, ["worktree", "add", "-q", "-b", branch, path]);
    if (file !== undefined) await commitFile(path, file, content, message);
    return path;
  }

  // Keeps git's automatic gc and maintenance off in a fixture repo.
  async function disableAutoGc(repo) {
    await git(repo, ["config", "gc.auto", "0"]);
    await git(repo, ["config", "maintenance.auto", "false"]);
  }

  // The real CLI runner seam (test/lib/checkKit.mjs): the same
  // NDJSON-per-line protocol as the Electron implementation, minus the
  // child bookkeeping the app needs.
  const { runCli, sm } = createCliRunner(smBinary, smEnv);

  return {
    sandbox,
    dataDir,
    smBinary,
    baseEnv,
    smEnv,
    git,
    gitOut,
    commitFile,
    addWorktree,
    disableAutoGc,
    runCli,
    sm,
    // Builds the sm binary from cli/ into the sandbox.
    buildSm: (env = baseEnv) =>
      execFileP("go", ["build", "-o", smBinary, "."], { cwd: cliDir, env }),
    // Seeds the data dir and points the host's CLI delegate at the
    // built binary through the runner seam.
    useCli() {
      initDataDirAt(dataDir);
      setCliRunnerImpl({
        runCli,
        requireCliBinary: () => smBinary,
        cliFailureMessage,
      });
    },
    // Registers a repo as a project through the CLI, returning its id.
    async projectIdOf(path) {
      const result = await sm("projects", "add", "--", path);
      const doc = result.docs.findLast((d) => typeof d.id === "string");
      assert.ok(doc, `projects add emitted no project doc for ${path}`);
      return doc.id;
    },
    remove: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}
