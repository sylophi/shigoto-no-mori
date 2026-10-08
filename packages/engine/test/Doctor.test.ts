// The doctor's checks, each against a hand-seeded data dir (and, where
// a repo is needed, a repo beside it), so the real ~/.sm is never read.
// The machine checks (git, gh, the app bundle, PATH) are left to their
// pure helpers, since their lines describe the machine, not the code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Doctor from "../src/Doctor.ts";
import {
  belowGitFloor,
  formatSize,
  launcherProgram,
  parseGitVersion,
  parsePortPoolDirs,
  parseProcessTable,
  parseSemver,
  compareVersions,
  scriptFileTokens,
} from "../src/doctorParse.ts";
import { engineLayer } from "../src/layer.ts";
import * as Registry from "../src/Registry.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import { nodeStore } from "./lib/nodeStore.ts";
import { macfs, type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// The engine's data dir, once the first call has copied the seed.
const dataDir = () => join(box.home, "engine");

const run = (
  options: {
    readonly fix?: boolean;
    readonly approve?: (repair: Doctor.Repair) => boolean;
  } = {},
) =>
  box.engine(
    Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
      doctor.run({
        version: "dev",
        executable: "",
        terminal: false,
        ...(options.fix === true
          ? {
              fix: {
                approve: (repair: Doctor.Repair) =>
                  Effect.succeed(options.approve?.(repair) ?? true),
              },
            }
          : {}),
      }),
    ),
  ) as Promise<Doctor.DoctorDocument>;

const findingsFor = (doc: Doctor.DoctorDocument, id: string) =>
  doc.checks.filter((finding) => finding.id === id);

// The one finding with the id, which must have the status.
const only = (
  doc: Doctor.DoctorDocument,
  id: string,
  status: Doctor.Status,
): Doctor.Finding => {
  const found = findingsFor(doc, id);
  assert.equal(found.length, 1, `${id}: ${JSON.stringify(doc.checks)}`);
  const [finding] = found;
  assert.ok(finding);
  assert.equal(finding.status, status, finding.detail);
  return finding;
};

const backdate = (file: string) => {
  const old = new Date("2020-01-02T03:04:05Z");
  utimesSync(file, old, old);
};

// A project "alpha" (A1) registered at <home>/alpha, configured on the
// in-project layout so its managed worktrees sit in the repo.
const alpha = (settings: Record<string, unknown> = {}) => {
  const repo = box.repo("alpha");
  box.write("registry.json", {
    projects: [{ id: "A1", name: "alpha", path: repo }],
  });
  box.write("projects/A1/project.json", {
    defaultBranch: "main",
    worktreeLayout: "in-project",
    ...settings,
  });
  const base = join(repo, ".shigomori", "worktrees");
  const tree = (name: string) => {
    const path = join(base, name);
    box.git(repo, "worktree", "add", "-q", "-b", name, path);
    return path;
  };
  return { repo, base, tree };
};

const marked = (mark: Registry.WorktreeMark) =>
  box.engine(
    Effect.flatMap(Effect.service(Registry.Registry), (registry) =>
      Effect.map(registry.marked(mark), (set) => [...set]),
    ),
  ) as Promise<string[]>;

// path -> a hash of its content, for every file under dir but the
// store's own, which a read may checkpoint.
const snapshot = (dir: string) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((file) => !file.startsWith("store.db"))
      .filter((file) => statSync(join(dir, file)).isFile())
      .map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(dir, file)))
          .digest("hex"),
      ]),
  );

// A folder holding a data dir's registry.
const seedDataDir = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "registry.json"), '{"projects":[]}');
};

// The tokens of a script command that name a repo file.
const tokens = (command: string) =>
  scriptFileTokens(command).map(({ token }) => token);

// Paths as they are, no home to expand.
const expand = (path: string) => path;

// Which of two versions ranks higher, none when either doesn't parse.
const order = (a: string, b: string) => {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  return x === undefined || y === undefined
    ? undefined
    : Math.sign(compareVersions(x, y));
};

describe("the data dir", () => {
  it("reads the device's settings, absent, valid or with a value of the wrong type", async () => {
    box.write("registry.json", { projects: [] });
    only(await run(), "config", "ok");
    await box.engine(
      Effect.flatMap(Effect.service(Config.Config), (config) =>
        config.set({ kind: "device" }, "portPool", "true"),
      ),
    );
    assert.equal(only(await run(), "config", "ok").detail, "valid, 1 key");
  });

  it("warns about a stored value of the wrong type", async () => {
    box.write("registry.json", { projects: [] });
    box.write("config.json", { portPool: "yes" });
    only(await run(), "config", "warn");
  });

  // A file the store can't import never gets this far: the store
  // refuses to open over it, and says which file.
  it("can't run over a config.json that isn't JSON", async () => {
    box.write("registry.json", { projects: [] });
    mkdirSync(join(box.home, "seed"), { recursive: true });
    writeFileSync(join(box.home, "seed", "config.json"), '{"portPool": true, ');
    await assert.rejects(run(), /config\.json could not be imported/);
  });

  it("counts the registered projects and warns about incomplete entries", async () => {
    box.write("registry.json", {
      projects: [{ id: "A", name: "a", path: "/tmp/a" }],
    });
    assert.equal(
      only(await run(), "registry", "ok").detail,
      "valid, 1 project registered",
    );
  });

  it("warns about a registry entry missing its path", async () => {
    box.write("registry.json", { projects: [{ id: "A", name: "a" }] });
    only(await run(), "registry", "warn");
  });

  it("finds stale locks only, in the data dir, the projects and iconCache, not updates/", async () => {
    box.write("registry.json", { projects: [] });
    box.write("state.json.lock", 1);
    box.write("projects/AAA/project.json.lock", 1);
    box.write("projects/AAA/project.json", {});
    box.write("iconCache/index.json.lock", 1);
    box.write("updates/something.lock", 1);
    for (const file of [
      "projects/AAA/project.json.lock",
      "iconCache/index.json.lock",
      "updates/something.lock",
    ]) {
      backdate(join(box.home, "seed", file));
    }
    const doc = await run();
    const finding = only(doc, "locks", "warn");
    assert.equal(finding.repairable, true);
    assert.match(
      finding.detail,
      /iconCache\/index\.json\.lock .*\(and 1 more\)/,
    );

    // Deleting them asks first, and nothing runs without a yes.
    const asked: Doctor.Repair[] = [];
    const declined = await run({
      fix: true,
      approve: (repair) => {
        asked.push(repair);
        return false;
      },
    });
    assert.deepEqual(declined.repaired, []);
    assert.equal(asked.length, 1);
    assert.match(asked[0]?.prompt ?? "", /^Delete 2 stale lock files \(/);
    assert.equal(asked[0]?.destructive, true);

    const fixed = await run({ fix: true });
    assert.deepEqual(fixed.repaired, ["deleted 2 stale lock files"]);
    only(fixed, "locks", "ok");
    statSync(join(dataDir(), "updates", "something.lock"));
    statSync(join(dataDir(), "state.json.lock"));
  });

  it("tells a live update stager from a crashed one, and a pidfile that holds no pid", async () => {
    box.write("registry.json", { projects: [] });
    assert.deepEqual(findingsFor(await run(), "staging-lock"), []);
    const pidfile = join(dataDir(), "updates", "staging.pid");
    mkdirSync(dirname(pidfile), { recursive: true });
    writeFileSync(pidfile, `${process.pid}\n`);
    only(await run(), "staging-lock", "ok");
    writeFileSync(pidfile, "nope");
    assert.match(
      only(await run(), "staging-lock", "warn").detail,
      /^left behind by a crashed update, so/,
    );
    writeFileSync(pidfile, "99999");
    const fixed = await run({ fix: true });
    assert.deepEqual(fixed.repaired, ["deleted the stale update staging lock"]);
    assert.deepEqual(findingsFor(fixed, "staging-lock"), []);
  });

  it("sweeps update scratch, but never while a stager owns it", async () => {
    box.write("registry.json", { projects: [] });
    assert.deepEqual(findingsFor(await run(), "update-leftovers"), []);
    const updates = join(dataDir(), "updates");
    mkdirSync(join(updates, "extract"), { recursive: true });
    writeFileSync(join(updates, "download.zip"), "x".repeat(2048));
    writeFileSync(join(updates, "extract", "a"), "x");
    assert.equal(
      only(await run(), "update-leftovers", "warn").detail,
      "2 KB of downloads left by an earlier update that nothing will install",
    );
    await run({ fix: true });
    assert.deepEqual(readdirSync(updates), []);

    writeFileSync(join(updates, "download.zip"), "x");
    writeFileSync(join(updates, "staging.pid"), String(process.pid));
    assert.deepEqual(findingsFor(await run(), "update-leftovers"), []);
  });

  it("counts marks and data that outlived their worktrees, the primary's own included as present", async () => {
    const { repo } = alpha();
    const primary = worktreeIdFromPath(repo);
    box.write("registry.json", {
      projects: [{ id: "A1", name: "alpha", path: repo }],
      shelvedWorktrees: { [primary]: true },
      autoPullWorktrees: { [primary]: true, "0123456789ab": true },
      shelfSnapshots: {
        ba9876543210: { at: 1, head: "abc", changed: 0 },
      },
    });
    box.write(`projects/A1/worktrees/${primary}.json`, { title: "t" });
    box.write("projects/A1/worktrees/cafecafecafe.json", { title: "t" });
    const finding = only(await run(), "bookkeeping", "warn");
    assert.match(finding.detail, /^2 marks and 1 data file /);
    assert.equal(finding.repairable, undefined);
  });

  it("says each state dir belongs to a project, and names the dormant one", async () => {
    box.write("registry.json", {
      projects: [{ id: "A1", name: "alpha", path: "/tmp/alpha" }],
    });
    box.write("projects/A1/project.json", { defaultBranch: "main" });
    box.write("projects/GONE/project.json", { defaultBranch: "main" });
    const finding = only(await run(), "dormant-state", "warn");
    assert.match(finding.detail, /\(GONE\)$/);
    assert.equal(finding.repairable, undefined);
  });

  it("stands the leftover checks down while terrier's list can't be read", async () => {
    box.write("registry.json", { projects: [] });
    box.write("config.json", { terrier: true });
    box.write("projects/A1/project.json", { defaultBranch: "main" });
    box.fakeBin("terrier", "exit 1");
    const doc = await run();
    only(doc, "terrier", "warn");
    assert.deepEqual(findingsFor(doc, "dormant-state"), []);
  });

  it("reads port-pool's allocations against the disk", async () => {
    box.write("registry.json", { projects: [] });
    box.write("config.json", { portPool: true });
    box.fakeBin(
      "port-pool",
      `echo "Current allocations:"; echo "  3038 -> ${box.home} (8/15/2026)"; echo "  4000 -> ${box.home}/gone (8/15/2026)"`,
    );
    assert.equal(
      only(await run(), "ports", "warn").detail,
      "1 of 2 allocations point at directories that are gone, so those ports stay reserved",
    );
  });
});

describe("a project", () => {
  it("offers to unregister one whose directory is gone, and forgets its settings", async () => {
    box.write("registry.json", {
      projects: [{ id: "GONE1", name: "ghost", path: join(box.home, "ghost") }],
    });
    box.write("projects/GONE1/project.json", { defaultBranch: "main" });
    const finding = only(await run(), "project-path", "fail");
    assert.equal(finding.repairable, true);
    const fixed = await run({ fix: true });
    assert.deepEqual(fixed.repaired, ["unregistered ghost"]);
    assert.equal(
      only(fixed, "registry", "ok").detail,
      "valid, 0 projects registered",
    );
    assert.equal(
      await box.engine(
        Effect.flatMap(Effect.service(Config.Config), (config) =>
          config.read({ kind: "project", projectId: "GONE1", path: "/x" }),
        ),
      ),
      null,
    );
  });

  it("never fixes a directory that stopped being a repo", async () => {
    const plain = join(box.home, "plain");
    mkdirSync(plain);
    box.write("registry.json", {
      projects: [{ id: "P1", name: "plain", path: plain }],
    });
    assert.equal(
      only(await run(), "project-repo", "fail").repairable,
      undefined,
    );
  });

  it("says a project registered through a symlink isn't matched by git", async () => {
    const repo = box.repo("real");
    const link = join(box.home, "link");
    symlinkSync(repo, link);
    box.write("registry.json", {
      projects: [{ id: "P1", name: "link", path: link }],
    });
    assert.match(
      only(await run(), "project-primary", "fail").detail,
      /^registered through a symlinked path/,
    );
  });

  it("gives a healthy project one line", async () => {
    alpha({ scripts: { setup: "pnpm install" } });
    assert.equal(only(await run(), "project", "ok").detail, "ok");
  });

  it("prunes metadata that outlived its directory, clearing what was kept for it", async () => {
    const { tree } = alpha();
    const vanished = tree("vanished");
    const id = worktreeIdFromPath(vanished);
    box.write("registry.json", {
      projects: [{ id: "A1", name: "alpha", path: join(box.home, "alpha") }],
      shelvedWorktrees: { [id]: true },
    });
    box.write(`projects/A1/worktrees/${id}.json`, { title: "x" });
    rmSync(vanished, { recursive: true });
    assert.equal(
      only(await run(), "project-worktrees", "warn").repairable,
      true,
    );
    const asked: Doctor.Repair[] = [];
    const fixed = await run({
      fix: true,
      approve: (repair) => {
        asked.push(repair);
        return true;
      },
    });
    // A checkout moved somewhere doctor doesn't look is severed by a
    // prune, so it asks first.
    assert.equal(asked.length, 1);
    assert.deepEqual(fixed.repaired, [
      "pruned git's worktree metadata for alpha",
    ]);
    assert.deepEqual(findingsFor(fixed, "project-worktrees"), []);
    assert.deepEqual(await marked("shelved"), []);
    assert.deepEqual(findingsFor(fixed, "bookkeeping"), []);
  });

  it("re-links a worktree moved by hand without asking, its marks following", async () => {
    const { repo, base } = alpha();
    const outside = join(box.home, "elsewhere", "feat");
    box.git(repo, "worktree", "add", "-q", "-b", "feat", outside);
    box.write("registry.json", {
      projects: [{ id: "A1", name: "alpha", path: repo }],
      shelvedWorktrees: { [worktreeIdFromPath(outside)]: true },
    });
    const moved = join(base, "feat");
    mkdirSync(base, { recursive: true });
    renameSync(outside, moved);
    const doc = await run();
    assert.deepEqual(findingsFor(doc, "project-worktrees"), []);
    assert.deepEqual(findingsFor(doc, "project-strays"), []);
    only(doc, "project-moved", "warn");
    const fixed = await run({
      fix: true,
      approve: () => assert.fail("re-linking only rewrites git's link files"),
    });
    assert.deepEqual(fixed.repaired, ["re-linked 1 moved worktree for alpha"]);
    box.git(moved, "status");
    assert.deepEqual(await marked("shelved"), [worktreeIdFromPath(moved)]);
  });

  it("won't prune while a moved worktree is still unlinked", async () => {
    const { repo, base, tree } = alpha();
    const outside = join(box.home, "elsewhere", "feat");
    box.git(repo, "worktree", "add", "-q", "-b", "feat", outside);
    const gone = tree("gone");
    const moved = join(base, "feat");
    renameSync(outside, moved);
    rmSync(gone, { recursive: true });
    // git can't write the re-link, so the moved worktree stays unlinked.
    const admin = join(repo, ".git", "worktrees", "feat");
    chmodSync(join(admin, "gitdir"), 0o444);
    chmodSync(admin, 0o555);
    try {
      const fixed = await run({ fix: true });
      assert.deepEqual(fixed.repaired, []);
      assert.equal(fixed.repairFailed.length, 2);
      assert.equal(
        fixed.repairFailed[1],
        "couldn't pruned git's worktree metadata for alpha: a moved worktree in alpha needs re-linking first (`git worktree repair <new path>`)",
      );
    } finally {
      chmodSync(admin, 0o755);
      chmodSync(join(admin, "gitdir"), 0o644);
    }
    box.git(moved, "status");
  });

  it("leaves a locked worktree whose directory is away", async () => {
    const { repo, tree } = alpha();
    const external = tree("external");
    box.git(repo, "worktree", "lock", external);
    rmSync(external, { recursive: true });
    assert.equal(only(await run(), "project", "ok").detail, "ok");
  });

  it("reports a stray folder in the managed layout and never removes it", async () => {
    const { base } = alpha();
    mkdirSync(join(base, "stray"), { recursive: true });
    const finding = only(await run(), "project-strays", "warn");
    assert.equal(finding.repairable, undefined);
    assert.match(finding.detail, /stray/);
  });

  it("warns about stored settings with no default branch", async () => {
    alpha();
    box.write("projects/A1/project.json", {
      scripts: { setup: "pnpm install" },
    });
    only(await run(), "project-config", "warn");
  });

  it("stays quiet when a bad default branch falls back, and warns when nothing resolves", async () => {
    alpha({ defaultBranch: "release/never-existed" });
    const empty = join(box.home, "empty");
    mkdirSync(empty);
    box.git(empty, "init", "-q", "-b", "main");
    box.write("registry.json", {
      projects: [
        { id: "A1", name: "alpha", path: join(box.home, "alpha") },
        { id: "E1", name: "empty", path: empty },
      ],
    });
    const finding = only(await run(), "project-branch", "warn");
    assert.equal(finding.title, "empty");
  });

  it("names a script file that isn't in the repo", async () => {
    box.repo("alpha", { "scripts/present.sh": "#!/bin/sh\n" });
    box.write("registry.json", {
      projects: [{ id: "A1", name: "alpha", path: join(box.home, "alpha") }],
    });
    box.write("projects/A1/project.json", {
      defaultBranch: "main",
      scripts: {
        setup: "bash scripts/present.sh && bash ./scripts/absent.sh --ci",
        teardown: "npx some-tool --config a/b/c.json",
      },
    });
    assert.deepEqual(
      findingsFor(await run(), "project-scripts").map(({ detail }) => detail),
      [
        "the setup script runs ./scripts/absent.sh, which isn't in the repo",
        "the teardown script runs a/b/c.json, which isn't in the repo",
      ],
    );
  });

  it("warns about a .worktreeinclude it can't read", async () => {
    const { repo } = alpha();
    const include = join(repo, ".worktreeinclude");
    writeFileSync(include, ".env\n");
    chmodSync(include, 0o000);
    try {
      only(await run(), "project-include", "warn");
    } finally {
      chmodSync(include, 0o644);
    }
  });

  it("names only the carry-over entries no checkout has", async () => {
    const { repo } = alpha({
      carryOver: [
        { path: ".env", mode: "copy" },
        { path: ".env.local", mode: "copy" },
      ],
    });
    writeFileSync(join(repo, ".env"), "X=1");
    const { detail } = only(await run(), "project-carryover", "warn");
    assert.match(detail, /\.env\.local/);
    assert.doesNotMatch(detail, /\.env,/);
  });

  it("names launchers whose program isn't there", async () => {
    alpha({
      launchers: [
        { id: "a", label: "shell", command: "sh -c true" },
        { id: "b", label: "ghost", command: "no-such-program-9f3a --flag" },
        { id: "c", label: "abs", command: "/no/such/binary" },
        { id: "d", label: "env", command: "$EDITOR ." },
      ],
    });
    assert.deepEqual(
      findingsFor(await run(), "project-launchers").map(({ detail }) => detail),
      [
        "the ghost launcher runs no-such-program-9f3a, which isn't installed or on PATH",
        "the abs launcher runs /no/such/binary, which isn't installed or on PATH",
      ],
    );
  });

  it("offers to delete landing refs an hour old or packed, never a fresh one", async () => {
    const { repo } = alpha();
    for (const name of ["fresh", "feat", "packed"]) {
      box.git(repo, "update-ref", `refs/shigomori/incoming/${name}`, "HEAD");
    }
    box.git(repo, "pack-refs", "--include", "refs/shigomori/incoming/packed");
    backdate(join(repo, ".git", "refs", "shigomori", "incoming", "feat"));
    const finding = only(await run(), "project-incoming", "warn");
    assert.match(finding.detail, /\(feat, packed\)/);
    await run({ fix: true });
    assert.equal(
      box.git(repo, "for-each-ref", "--format=%(refname)", "refs/shigomori/"),
      "refs/shigomori/incoming/fresh\n",
    );
  });

  it("reports a gone terrier project without offering to unregister it, and checks a present one", async () => {
    const { repo, tree } = alpha();
    rmSync(tree("vanished"), { recursive: true });
    const gone = join(box.home, "gone");
    box.write("registry.json", { projects: [] });
    box.write("config.json", { terrier: true });
    box.fakeBin(
      "terrier",
      `case "$1" in version) echo v0.1.3;; ls) echo '{"projects":[{"path":"${gone}"},{"path":"${repo}"}]}';; esac`,
    );
    const doc = await run();
    const finding = only(doc, "project-path", "warn");
    assert.equal(finding.repairable, undefined);
    assert.match(finding.fix ?? "", /terrier prune/);
    only(doc, "project-worktrees", "warn");
  });
});

describe("the run", () => {
  it("writes nothing without the fix", async () => {
    const { repo } = alpha();
    box.write("state.json.lock", 1);
    box.write("updates/staging.pid", 99999);
    backdate(join(box.home, "seed", "state.json.lock"));
    await run();
    const before = [snapshot(dataDir()), snapshot(repo)];
    const doc = await run();
    assert.ok(doc.checks.length > 0);
    assert.equal(doc.summary.fail, 0);
    assert.deepEqual([snapshot(dataDir()), snapshot(repo)], before);
  });

  it("repairs nothing on a healthy data dir", async () => {
    alpha();
    const doc = await run({ fix: true });
    assert.equal(doc.checks.filter(({ repairable }) => repairable).length, 0);
    assert.deepEqual(doc.repaired, []);
  });

  it("is ok exactly when nothing failed, and counts each status", async () => {
    box.write("registry.json", {
      projects: [{ id: "G", name: "ghost", path: join(box.home, "ghost") }],
    });
    const doc = await run();
    assert.equal(doc.ok, false);
    assert.equal(
      doc.summary.ok + doc.summary.warn + doc.summary.fail,
      doc.checks.length,
    );
    assert.equal(doc.summary.fail, 1);
  });
});

// A run against a home of its own, with no SHIGOMORI_DATA_DIR, so the
// data dir is found the way it is on a machine.
describe("the data dir found by pointer", () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "engine-doctor-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const runAt = async () => {
    const runtime = ManagedRuntime.make(
      engineLayer({ flavor: "dev", store: nodeStore, macfs: macfs() }).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { HOME: home, PATH: process.env.PATH ?? "" },
            }),
          ),
        ),
      ),
    );
    try {
      return await runtime.runPromise(
        Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
          doctor.run({ version: "dev", executable: "", terminal: false }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  };

  const pointTo = (target: string) => {
    mkdirSync(join(home, ".config", "shigomori-dev"), { recursive: true });
    writeFileSync(join(home, ".config", "shigomori-dev", "data-dir"), target);
  };

  it("says why a pointer was ignored", async () => {
    seedDataDir(join(home, ".smd"));
    pointTo("relative/path\n");
    assert.match(
      only(await runAt(), "data-dir", "warn").detail,
      /^the pointer file names relative\/path, which was ignored because it isn't an absolute path/,
    );
  });

  it("warns about a default data dir left beside the pointed one", async () => {
    seedDataDir(join(home, ".smd"));
    seedDataDir(join(home, "elsewhere"));
    pointTo(join(home, "elsewhere"));
    assert.match(
      only(await runAt(), "data-dir", "warn").detail,
      /also holds state and is ignored$/,
    );
  });

  it("reads a symlinked default as the same data, not an ignored copy", async () => {
    seedDataDir(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(home, ".smd"));
    pointTo(join(home, "elsewhere"));
    only(await runAt(), "data-dir", "ok");
  });
});

describe("the parsers", () => {
  it("reads port-pool's allocations, and nothing from what it doesn't recognize", () => {
    assert.deepEqual(
      parsePortPoolDirs(`Current allocations:
  3038 -> /Users/x/worktrees/alpha (8/15/2026, 5:45:00 PM)
    renderer=3038
  4072 -> /Users/x/web/songloupe (8/15/2026, 6:46:41 PM)
`),
      ["/Users/x/worktrees/alpha", "/Users/x/web/songloupe"],
    );
    assert.deepEqual(parsePortPoolDirs("something else entirely\n"), []);
  });

  it("reads git's version against the 2.40 floor", () => {
    for (const [raw, want] of [
      ["2.39.5", { major: 2, minor: 39 }],
      ["2.54.0 (Apple Git-157)", { major: 2, minor: 54 }],
      ["2.51.0.1", { major: 2, minor: 51 }],
      ["2.30", { major: 2, minor: 30 }],
      ["3", { major: 3, minor: 0 }],
      ["", undefined],
      ["unknown", undefined],
    ] as const) {
      assert.deepEqual(parseGitVersion(raw), want, raw);
    }
    assert.equal(belowGitFloor(2, 39), true);
    assert.equal(belowGitFloor(2, 40), false);
    assert.equal(belowGitFloor(3, 0), false);
  });

  it("checks only script tokens that unambiguously name a repo file", () => {
    assert.deepEqual(tokens("pnpm install"), []);
    assert.deepEqual(tokens("bash ./scripts/x.sh --ci"), ["./scripts/x.sh"]);
    assert.deepEqual(tokens("bash scripts/x.sh"), ["scripts/x.sh"]);
    assert.deepEqual(tokens("bash $SETUP/x.sh"), []);
    assert.deepEqual(tokens("curl https://example.com/x.sh | sh"), []);
    assert.deepEqual(tokens("make setup"), []);
    assert.deepEqual(tokens("bash /opt/x.sh"), []);
    assert.deepEqual(tokens("npx some-tool --config a/b/c.json"), [
      "a/b/c.json",
    ]);
  });

  it("finds a launcher's program only when no shell is needed to tell", () => {
    for (const [command, want] of [
      ["code .", "code"],
      ["/usr/bin/open -a Foo .", "/usr/bin/open"],
      ['"/opt/tool" --x', "/opt/tool"],
      ['"/Applications/My App/x" .', ""],
      ["FOO=1 claude", ""],
      ["$EDITOR .", ""],
      ["cd sub && make", ""],
      ["./scripts/dev.sh", ""],
      ["(cd x; y)", ""],
      ["", ""],
    ] as const) {
      assert.equal(launcherProgram(command, expand), want, command);
    }
  });

  it("reads each pid's start time from ps", () => {
    const table = parseProcessTable("  4242 Mon Aug 17 18:42:41 2026\nnoise\n");
    assert.deepEqual(
      [...table],
      [[4242, new Date(2026, 7, 17, 18, 42, 41).getTime()]],
    );
  });

  it("sizes in the units Go's sm prints, and ranks versions", () => {
    assert.deepEqual([10, 2048, 5 * 2 ** 20 + 1, 3 * 2 ** 30].map(formatSize), [
      "10 bytes",
      "2 KB",
      "5 MB",
      "3.0 GB",
    ]);
    assert.equal(order("2.1.0", "2.0.9"), 1);
    assert.equal(order("2.0.0-beta.2", "2.0.0"), -1);
    assert.equal(order("2.0.0-beta.10", "2.0.0-beta.9"), 1);
    assert.equal(order("2.0.0", "dev"), undefined);
  });
});
