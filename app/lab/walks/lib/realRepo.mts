// A real project for the cross-device walks: this repository at a
// pinned commit (2,562 files, 1,076 commits), cloned from an origin the
// walk serves on loopback, as a laptop has it: origin/main the
// default branch (what `projects add` seeds from a fetched origin), and
// the owner's project settings, carry-over of two gitignored files, one
// of them ignored only by the user's own excludes, and a setup script.
// No network: the commits come from this checkout.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freeLoopbackPort, waitFor } from "../../../test/lib/checkKit.mts";
import type { Lab } from "./labApp.mts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..", "..");

// release/v3 at the walks' start, and two of its ancestors as the
// remote's other branches.
const BRANCHES = {
  main: "ae8982c174d5f1d6efaf722256772cd485f2c885",
  "earlier-work": "aaec32589ac8139a721217049ec059a9be20ef58",
  "old-release": "2a46b3eb4bedb8bd2466035c454a4f31064135ff",
};

export const REAL_NAME = "shigoto-no-mori";

// What a setup script does here, cheaply: a real command that reads the
// tree and writes into the worktree's gitignored node_modules, for a few
// seconds. The owner's own (`pnpm install && pnpm run postinstall`) is the
// hand sweep's, at minutes and gigabytes a walk can't spend
// (../walks.md).
const WALK_SETUP =
  "mkdir -p node_modules/.walk-setup && git ls-files -z | xargs -0 shasum -a 256 > node_modules/.walk-setup/sums";

// The carry-over the owner's project has, with contents nobody minds.
export const CARRIED = {
  "CLAUDE.local.md": "# Local notes\n\nA walk's, nothing secret.\n",
  "app/.env.local": "SM_WALK_SETTING=walk\n",
} as const;

// The project's settings as the owner's device has them, set through
// the bundle's terminal command as the user would.
export function applyOwnerSettings(lab: Lab, project: string = REAL_NAME) {
  lab.sm(
    "projects",
    "config",
    "--default-branch",
    "origin/main",
    "--setup",
    WALK_SETUP,
    "-p",
    project,
  );
  lab.sm(
    "projects",
    "config",
    "set",
    "lastMergeMethod",
    "squash",
    "-p",
    project,
  );
  for (const path of Object.keys(CARRIED)) {
    lab.sm(
      "projects",
      "config",
      "carryover",
      "add",
      path,
      "--copy",
      "-p",
      project,
    );
  }
}

export interface RealOrigin {
  // What the clones name as origin: a git:// URL on loopback, which a
  // clone from a peer carries as a remote (a path it would not).
  readonly url: string;
  readonly path: string;
  stop(): Promise<void>;
}

// The project's remote: a bare repository of this checkout's commits,
// served by `git daemon` on loopback for the walk's devices to fetch.
export async function startRealOrigin(): Promise<RealOrigin> {
  const base = mkdtempSync(join(tmpdir(), "sm-walk-origin-"));
  const path = join(base, `${REAL_NAME}.git`);
  execFileSync("git", ["init", "-q", "--bare", path]);
  execFileSync(
    "git",
    [
      "-c",
      "push.gpgSign=false",
      "push",
      "-q",
      "--no-verify",
      path,
      ...Object.entries(BRANCHES).map(
        ([branch, commit]) => `${commit}:refs/heads/${branch}`,
      ),
    ],
    { cwd: REPOSITORY },
  );
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: path,
  });
  const port = await freeLoopbackPort();
  const daemon = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--export-all",
      `--base-path=${base}`,
      "--listen=127.0.0.1",
      `--port=${port}`,
      base,
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  daemon.once("exit", () => {
    exited = true;
  });
  const stop = async () => {
    if (!exited) daemon.kill("SIGTERM");
    await waitFor(() => exited, "git daemon to stop", 10_000).catch(() =>
      daemon.kill("SIGKILL"),
    );
    rmSync(base, { recursive: true, force: true });
  };
  const url = `git://127.0.0.1:${port}/${REAL_NAME}.git`;
  try {
    await waitFor(
      () => {
        if (exited) throw new Error("git daemon exited");
        return (
          spawnSync("git", ["ls-remote", url, "main"], { stdio: "ignore" })
            .status === 0
        );
      },
      "git daemon",
      20_000,
    );
  } catch (cause) {
    await stop();
    throw cause;
  }
  return { url, path, stop };
}

// The user's own excludes, as the owner's machines have them: the one
// place CLAUDE.local.md is ignored.
export function writeUserExcludes(home: string) {
  const ignore = join(home, ".config", "git", "ignore");
  mkdirSync(dirname(ignore), { recursive: true });
  writeFileSync(ignore, "CLAUDE.local.md\n");
}

// A clone of the project at `reposDir/<at>`, with the user's excludes
// and the carried files in place. Answers the clone's path.
export function seedRealProject(
  reposDir: string,
  git: Lab["git"],
  home: string,
  origin: RealOrigin,
  at: string = REAL_NAME,
): string {
  writeUserExcludes(home);
  const repo = join(reposDir, at);
  git(reposDir, "clone", "-q", origin.url, repo);
  for (const [path, text] of Object.entries(CARRIED)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  return repo;
}
