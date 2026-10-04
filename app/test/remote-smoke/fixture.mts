// The remote smoke's world, shared by boot.mts (which seeds it before
// device a starts and clears it when weblab stops a device) and
// smoke.mts (whose scenarios read and write it).
//
// Two dev profiles (scripts/lib/devProfile.mts) as two devices of the
// owner's dev account, both signed in by cloning the plain dev
// instance's sign-in. One repo is cloned into both forests: the pull
// matches a local project by repo identity (the root commit), so two
// seeds would not do, the same clone on two machines is the real
// shape. The paths are fixed, so the two files agree on them without
// talking, which is also why one run at a time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDevCli,
  cloneDevLogin,
  devProfilePaths,
  PROFILES_DIR,
  registerProjects,
  rmTree,
  wipeDevProfile,
  type DevProfile,
} from "../../scripts/lib/devProfile.mts";
import { scrubbedGitEnv } from "../lib/checkKit.mts";

export type Side = "a" | "b";

export type Fixture = { a: DevProfile; b: DevProfile; origin: string };

export const fixture: Fixture = {
  a: devProfilePaths("e2e-a"),
  b: devProfilePaths("e2e-b"),
  origin: join(PROFILES_DIR, "e2e-origin.git"),
};

// Scratch space for a run: the seed repo, the setup log, the scenarios'
// own repos and markers, and each device's boot pid.
export const runDir = join(tmpdir(), "sm-e2e");

// The boot process of a side, for the scenarios that kill a device
// outright (a SIGKILL to its whole tree).
export const bootPidFile = (side: Side) => join(runDir, `boot-${side}.pid`);

// Git against the fixture worktrees, both of which live on this
// machine: pinned identity, the inherited GIT_* scrubbed (a lefthook
// run exports GIT_DIR for the real repository).
export const gitEnv = {
  ...scrubbedGitEnv(),
  GIT_AUTHOR_NAME: "E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
// A mirror's git follower writes the copy's index between the test's
// own git calls, so a call can meet its lock. Git's own advice holds:
// the lock is momentary, so the call is retried a few times before it
// counts as a failure.
const INDEX_LOCK_RETRIES = 10;
export const git = (cwd: string, ...args: string[]): Buffer => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
      if (!stderr.includes("index.lock") || attempt >= INDEX_LOCK_RETRIES) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
};
export const gitOut = (cwd: string, ...args: string[]) =>
  git(cwd, ...args)
    .toString()
    .trim();

// Every run of a's setup script appends the worktree it ran in here,
// outside both forests so no mirror carries it: the pull scenarios
// read it to tell a create that ran setup from one told to skip it.
export const setupLog = join(runDir, "setup-runs.log");
export const setupRuns = (): string[] =>
  existsSync(setupLog)
    ? readFileSync(setupLog, "utf8").split("\n").filter(Boolean)
    : [];

// a's setup script: logs the run, then builds an ignored artifact the
// way an install or a build would, so a transplant that also brings
// the source's build output has something to disagree with.
export const BUILT_ON_A = "built on a\n";
export const SETUP_SCRIPT = `pwd >> ${JSON.stringify(setupLog)} && mkdir -p build-out && printf 'built on a\\n' > build-out/artifact.txt`;

// Gives the profile's one project a setup script, written straight
// into its project.json the way Project Settings would.
function configureSetupScript(profile: DevProfile, command: string): void {
  const projects = join(profile.dataDir, "projects");
  const [projectId, ...rest] = readdirSync(projects);
  assert.ok(
    projectId !== undefined && rest.length === 0,
    `expected one project under ${projects}`,
  );
  const configPath = join(projects, projectId, "project.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  config.scripts = { ...config.scripts, setup: command };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

// Both profiles from nothing: wiped, the shared repo cloned into each
// and registered, the dev sign-in cloned in, and a's setup script set.
export function seedFixture(): void {
  const { a, b, origin } = fixture;
  wipeDevProfile(a);
  wipeDevProfile(b);
  rmTree(runDir);
  mkdirSync(runDir, { recursive: true });
  buildDevCli();

  rmTree(origin);
  const seed = join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "e2e shared repo\n");
  // What a real project ignores: secrets, build output, a cache. The
  // pull scenarios put files under each and watch which ones travel.
  writeFileSync(join(seed, ".gitignore"), ".env\nbuild-out/\ncache/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Initial");
  git(seed, "init", "--bare", "-q", "-b", "main", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  // A repo only b has, with no remote to clone it from: the mirror
  // onto a device with no checkout has to bring it over the device
  // link itself.
  const lone = join(b.repos, "lone");
  mkdirSync(lone, { recursive: true });
  git(lone, "init", "-q", "-b", "main");
  writeFileSync(join(lone, "README.md"), "only on b\n");
  git(lone, "add", ".");
  git(lone, "commit", "-q", "-m", "Initial");

  for (const profile of [a, b]) {
    mkdirSync(profile.repos, { recursive: true });
    mkdirSync(profile.dataDir, { recursive: true });
    git(profile.repos, "clone", "-q", origin, "shared");
    registerProjects(profile, profile.repos);
    cloneDevLogin(profile);
  }
  configureSetupScript(a, SETUP_SCRIPT);
}

// Whether any process still runs on the profile: every Electron helper
// names its userData in its arguments, and the last of them (the
// network service) can outlive the launcher by a moment, writing into
// a folder a wipe already took.
function profileInUse(profile: DevProfile): boolean {
  return execFileSync("ps", ["-A", "-o", "command="])
    .toString()
    .includes(`--user-data-dir=${profile.userData}`);
}

// What a side leaves on this machine once its window is gone: its
// profile, and for a, which seeded them, the origin and the run's
// scratch space too. It waits out the window's last processes first.
// Each removal stands on its own and none throws: what is left over is
// named, and the next seed wipes it again.
export async function clearSide(side: Side): Promise<void> {
  const profile = fixture[side];
  const until = Date.now() + 15_000;
  while (profileInUse(profile) && Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- a poll is sequential by nature
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const removals: [string, () => void][] = [
    [profile.name, () => wipeDevProfile(profile)],
  ];
  if (side === "a") {
    removals.push(
      ["the shared origin", () => rmTree(fixture.origin)],
      ["the run directory", () => rmTree(runDir)],
    );
  }
  for (const [what, remove] of removals) {
    try {
      remove();
    } catch (error) {
      console.error(`[e2e] couldn't remove ${what}: ${String(error)}`);
    }
  }
}
