// Durable proof for "Nuke everything" against REAL git repositories:
// the host's half refuses for a trap and touches nothing, removes every
// worktree the app made (and only those) with a second run finishing
// what an interrupted first left, each removal announced as any delete
// is, with no teardown script holding it up, and reports what it
// couldn't; the
// next start's half deletes what the marker names and all of userData
// but the lock and the dev profiles, and finishes after a start that
// died halfway through.
//
// Run: pnpm test nuke.
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { onHostPush } from "./lib/hostStandIns.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import {
  finishPendingNuke,
  NUKE_MARKER,
  writeNukeMarker,
} from "../main/core/nuke/finish.ts";

const fixture = cliSandbox("sm-nuke-");
beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
});
afterAll(() => fixture.remove());
const { dataDir, git, commitFile, sandbox } = fixture;

const { nukeEverything, nukeTrap, leftIf } =
  await import("../host/lib/nuke.ts");

// A nuke with nothing installed outside the sandbox to take off: the
// proof's own record of what it was asked to uninstall.
const nuke = (
  uninstalled: string[],
  onProgress: (progress: { phase: string }) => void = () => {},
  teardownTimeoutMs?: number,
) =>
  runHost(
    nukeEverything({
      onProgress: (progress) => Effect.sync(() => onProgress(progress)),
      killAllScripts: Effect.void,
      closeTerminals: Effect.void,
      holdUpdater: Effect.succeed(null),
      uninstall: Effect.sync(() => {
        uninstalled.push("hooks");
        return [];
      }),
      home: join(sandbox, "home"),
      ...(teardownTimeoutMs === undefined ? {} : { teardownTimeoutMs }),
    }),
  );

// Every removal announcement from here on, as `<worktree id> <state>`.
const announced: string[] = [];
onHostPush((push) => {
  if (push.channel !== "worktrees:removal") return;
  const { worktreeId, state } = push.payload as {
    worktreeId: string;
    state: string;
  };
  announced.push(`${worktreeId} ${state}`);
});

class ReadOnly extends Schema.TaggedError<ReadOnly>()("ReadOnly", {}) {
  override get message(): string {
    return "read-only file";
  }
}

const repo = async (name: string) => {
  const path = join(sandbox, name);
  await git(sandbox, ["init", "-q", "-b", "main", path]);
  await commitFile(path, "a.txt", "a\n", "seed");
  return path;
};

const worktrees = async (project: string) =>
  (await git(project, ["worktree", "list", "--porcelain"])).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

it("names its traps: a project inside the data dir, or home as it", () => {
  const home = "/Users/someone";
  const project = (path: string) =>
    ({ id: "p", name: "inside", path }) as Parameters<typeof nukeTrap>[0][0];
  assert.match(
    nukeTrap([], "/Users", home) ?? "",
    /the data folder is \/Users, which holds your home folder/,
  );
  assert.match(nukeTrap([], home, home) ?? "", /holds your home folder/);
  assert.equal(nukeTrap([project("/elsewhere")], dataDir, home), null);
  assert.match(
    nukeTrap([project(join(dataDir, "repo"))], dataDir, home) ?? "",
    /project "inside" lives inside/,
  );
});

it("refuses for a project inside the data dir, touching nothing", async () => {
  const outside = await repo("outside");
  await fixture.projectIdOf(outside);
  const kept = join(dataDir, "wt", "outside", "kept");
  await git(outside, ["worktree", "add", "-q", "-b", "kept", kept]);
  const inside = join(dataDir, "trapped");
  await git(sandbox, ["init", "-q", "-b", "main", inside]);
  await commitFile(inside, "a.txt", "a\n", "seed");
  await fixture.projectIdOf(inside);
  const uninstalled: string[] = [];
  await assert.rejects(nuke(uninstalled), /project "trapped" lives inside/);
  assert.ok(existsSync(kept), "no worktree went");
  assert.deepEqual(uninstalled, [], "nothing was uninstalled");
  // Out of the way for the next proofs: the trap's repo, unregistered.
  await fixture.sm("projects", "remove", "--yes", inside);
  rmSync(inside, { recursive: true, force: true });
});

it("refuses while an update installs, in its words, before a script is stopped", async () => {
  let scriptsStopped = false;
  await assert.rejects(
    runHost(
      nukeEverything({
        onProgress: () => Effect.void,
        killAllScripts: Effect.sync(() => {
          scriptsStopped = true;
        }),
        closeTerminals: Effect.void,
        holdUpdater: Effect.succeed("3.1.0"),
        uninstall: Effect.succeed([]),
        home: join(sandbox, "home"),
      }),
    ),
    /The update to 3\.1\.0 is installing, and the app restarts into it\. Reset after the restart\./,
  );
  assert.equal(scriptsStopped, false, "a script was stopped first");
});

it("removes every worktree the app made, and a second run finishes an interrupted first", async () => {
  const project = await repo("project");
  await fixture.projectIdOf(project);
  const managed = ["fox", "otter", "heron"].map((name) =>
    join(dataDir, "wt", basename(project), name),
  );
  // One at a time: each rewrites the repo's worktree metadata.
  await managed.reduce(
    (previous, path) =>
      previous.then(() =>
        git(project, ["worktree", "add", "-q", "-b", basename(path), path]),
      ),
    Promise.resolve({ stdout: "", stderr: "" }),
  );
  const inProject = join(project, ".shigomori", "wt", "wren");
  await git(project, ["worktree", "add", "-q", "-b", "wren", inProject]);
  const external = join(sandbox, "external");
  await git(project, ["worktree", "add", "-q", "-b", "external", external]);

  // Interrupted after its first removal, as a quit or a crash would.
  const first: string[] = [];
  await assert.rejects(
    nuke(first, (progress) => {
      if (
        progress.phase === "worktrees" &&
        "done" in progress &&
        progress.done === 1
      ) {
        throw new Error("interrupted");
      }
    }),
  );
  const between = await worktrees(project);
  assert.ok(between.length < 6, "the first run removed one");
  assert.ok(between.length > 2, "and stopped there");
  assert.deepEqual(first, [], "it never reached the uninstall");

  const second: string[] = [];
  announced.length = 0;
  const report = await nuke(second);
  assert.deepEqual(report.left, []);
  // Each removal is announced as going, then gone, as any delete is.
  const going = between.length - 2;
  assert.equal(
    announced.filter((entry) => entry.endsWith(" removing")).length,
    going,
  );
  assert.deepEqual(
    announced
      .filter((entry) => entry.endsWith(" removed"))
      .map((entry) => entry.replace(" removed", " removing"))
      .toSorted(),
    announced.filter((entry) => entry.endsWith(" removing")).toSorted(),
  );
  assert.deepEqual(second, ["hooks"]);
  // The outside project's worktree from the refusal went too.
  assert.deepEqual((await worktrees(project)).toSorted(), [external, project]);
  for (const path of [...managed, inProject]) {
    assert.ok(!existsSync(path), `${path} is gone`);
  }
  assert.ok(
    !existsSync(join(project, ".shigomori")),
    "the in-project folder it left empty went with it",
  );
  assert.ok(existsSync(join(project, "a.txt")), "the repo is untouched");
  assert.ok(existsSync(join(external, "a.txt")), "so is the external one");

  // A third run finds nothing to do.
  assert.deepEqual((await nuke([])).left, []);
});

it("a teardown script that never ends, deaf to SIGTERM, holds no nuke up", async () => {
  const project = await repo("slow");
  await fixture.projectIdOf(project);
  await fixture.sm(
    "projects",
    "config",
    "-p",
    "slow",
    "--teardown",
    // A sleep no other process runs, to look for after.
    "trap '' TERM; sleep 6017",
  );
  const kite = join(dataDir, "wt", "slow", "kite");
  await git(project, ["worktree", "add", "-q", "-b", "kite", kite]);
  const started = Date.now();
  await nuke([], undefined, 1000);
  assert.ok(Date.now() - started < 30_000, "the nuke waited on the teardown");
  assert.ok(!existsSync(kite), "the worktree went all the same");
  // The script's shell is killed; what it started in the background
  // outlives it by design (Lifecycle.ts), so the proof ends its own.
  const orphans = spawnSync("pgrep", ["-f", "sleep 6017"]).stdout.toString();
  for (const pid of orphans.split("\n").filter(Boolean)) {
    process.kill(Number(pid), "SIGKILL");
  }
});

it("reports what it couldn't uninstall, with why", async () => {
  const report = await runHost(
    nukeEverything({
      onProgress: () => Effect.void,
      killAllScripts: Effect.void,
      closeTerminals: Effect.void,
      holdUpdater: Effect.succeed(null),
      uninstall: Effect.map(
        Effect.all([
          leftIf("The agent hooks", Effect.fail(new ReadOnly())),
          leftIf("The terminal command", Effect.void),
        ]),
        (lists) => lists.flat(),
      ),
      home: join(sandbox, "home"),
    }),
  );
  assert.deepEqual(report.left, [
    { what: "The agent hooks", why: "read-only file" },
  ]);
});

it("deletes at the next start what the marker names and all of userData, the lock and the profiles aside", () => {
  const root = join(sandbox, "start");
  const userData = join(root, "userData");
  const data = join(root, "data");
  const logs = join(root, "logs");
  const pointer = join(root, "config", "data-dir");
  for (const dir of [
    join(userData, "Local Storage"),
    join(userData, "profiles", "other"),
    join(data, "wt"),
    logs,
    join(root, "config"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of [
    join(userData, "clerk-tokens.json"),
    join(userData, "account.json"),
    join(userData, "clientConfig.json"),
    join(userData, "SingletonLock"),
    join(userData, "profiles", "other", "account.json"),
    join(data, "store.db"),
    join(logs, "main.log"),
    pointer,
  ]) {
    writeFileSync(file, "x");
  }
  writeNukeMarker(userData, [data, logs, pointer]);

  // A start that died after the data dir went: the next one finishes.
  rmSync(data, { recursive: true, force: true });
  assert.deepEqual(finishPendingNuke(userData), { left: [] });
  for (const path of [data, logs, pointer]) assert.ok(!existsSync(path), path);
  assert.deepEqual(readdirSync(userData).toSorted(), [
    "SingletonLock",
    "profiles",
  ]);
  assert.ok(existsSync(join(userData, "profiles", "other", "account.json")));
  assert.ok(!existsSync(join(userData, NUKE_MARKER)));
  assert.ok(existsSync(join(root, "config")), "only the pointer itself");

  // And a start with no marker deletes nothing.
  writeFileSync(join(userData, "clientConfig.json"), "{}");
  assert.equal(finishPendingNuke(userData), null);
  assert.ok(existsSync(join(userData, "clientConfig.json")));

  // Nor one whose marker can't be read, which stays: half a nuke would
  // leave the data dir with userData gone.
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "store.db"), "x");
  writeFileSync(join(userData, NUKE_MARKER), '{"paths": ["');
  assert.equal(finishPendingNuke(userData), null);
  assert.ok(existsSync(join(data, "store.db")));
  assert.ok(existsSync(join(userData, "clientConfig.json")));
  assert.ok(existsSync(join(userData, NUKE_MARKER)));
  assert.ok(!existsSync(join(userData, `${NUKE_MARKER}.tmp`)));
});

it("deletes all it can past a path it can't, says which, and keeps the marker for the next start", () => {
  const root = join(sandbox, "stuck");
  const userData = join(root, "userData");
  const data = join(root, "data");
  const held = join(root, "held");
  for (const dir of [userData, data, held]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userData, "account.json"), "x");
  writeFileSync(join(data, "store.db"), "x");
  writeFileSync(join(held, "file"), "x");
  writeNukeMarker(userData, [join(held, "file"), data]);
  // A folder its file can't leave (a worktree's read-only directory).
  chmodSync(held, 0o500);
  try {
    const finished = finishPendingNuke(userData);
    assert.equal(finished?.left.length, 1);
    assert.equal(finished?.left[0]?.path, join(held, "file"));
    assert.match(finished?.left[0]?.why ?? "", /permission denied|EACCES/i);
    assert.ok(!existsSync(data), "stopped at the path it couldn't delete");
    assert.ok(!existsSync(join(userData, "account.json")));
    assert.ok(existsSync(join(userData, NUKE_MARKER)));
  } finally {
    chmodSync(held, 0o700);
  }
  assert.deepEqual(finishPendingNuke(userData), { left: [] });
  assert.ok(!existsSync(join(held, "file")));
  assert.ok(!existsSync(join(userData, NUKE_MARKER)));
});

it("names the file that stayed deep in a folder the marker names, the rest of the folder gone", () => {
  const root = join(sandbox, "deep");
  const userData = join(root, "userData");
  const top = join(root, "top");
  const held = join(top, "a", "held");
  for (const dir of [userData, held, join(top, "z")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(held, "file"), "x");
  writeFileSync(join(top, "z", "other"), "x");
  writeNukeMarker(userData, [top]);
  chmodSync(held, 0o500);
  try {
    assert.deepEqual(finishPendingNuke(userData), {
      left: [{ path: join(held, "file"), why: "permission denied" }],
    });
    assert.ok(!existsSync(join(top, "z")), "stopped at the first that stayed");
  } finally {
    chmodSync(held, 0o700);
  }
});
