// A data dir reached through a symlink (/tmp on macOS, or a data dir
// linked to another drive), where git lists worktrees under the
// resolved path: `worktrees create` and the doctor's drift checks
// (real git on a sandbox).
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Doctor from "../src/Doctor.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox | undefined;
let links: string | undefined;
// A real install's node_modules takes a while to remove.
afterEach(async () => {
  await box?.remove();
  if (links !== undefined) rmSync(links, { recursive: true, force: true });
}, 60_000);

// A project, and the worktree `fox` made in it.
const symlinkedFox = async () => {
  links = mkdtempSync(join(tmpdir(), "engine-links-"));
  const real = join(links, "real");
  mkdirSync(real);
  const dataDir = join(links, "data");
  symlinkSync(real, dataDir);
  const sandboxed = sandbox({ env: { SHIGOMORI_DATA_DIR: dataDir } });
  box = sandboxed;
  const repo = sandboxed.repo("proj", { "README.md": "hi\n" });
  const created = (await sandboxed.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      return yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
    }),
  )) as { worktree?: Worktrees.WorktreeRow; error?: string };
  return { box: sandboxed, created };
};

it("creates a managed worktree under a data dir behind a symlink", async () => {
  const { created } = await symlinkedFox();
  assert.equal(created.error, undefined);
  assert.equal(created.worktree?.branch, "fox");
  assert.equal(created.worktree?.isExternal, false);
});

it("reads a worktree renamed by hand there as moved, not a stray", async () => {
  const { box: sandboxed, created } = await symlinkedFox();
  const fox = created.worktree?.path;
  assert.ok(fox);
  renameSync(fox, join(dirname(fox), "otter"));
  const doc = (await sandboxed.engine(
    Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
      doctor.run({ version: "dev", executable: "", terminal: false }),
    ),
  )) as Doctor.DoctorDocument;
  const ids = doc.checks.map((finding) => finding.id);
  assert.ok(!ids.includes("project-strays"), JSON.stringify(doc.checks));
  assert.equal(ids.filter((id) => id === "project-moved").length, 1);
});

it("names the default branch's local branch from the ref it resolved: the remote's branch for a remote-tracking ref, a stale remote's too, and a local branch named like a remote ref as itself", async () => {
  box = sandbox();
  const sandboxed = box;
  const repo = sandboxed.repo("proj", { "README.md": "hi\n" });
  const tip = sandboxed.git(repo, "rev-parse", "HEAD").trim();
  sandboxed.git(
    repo,
    "remote",
    "add",
    "origin",
    "https://example.com/proj.git",
  );
  sandboxed.git(repo, "update-ref", "refs/remotes/origin/main", tip);
  sandboxed.git(repo, "update-ref", "refs/remotes/gone/trunk", tip);
  sandboxed.git(repo, "branch", "origin/feat");
  const targetWith = (defaultBranch: string | undefined) =>
    sandboxed.engine(
      Effect.gen(function* () {
        const registry = yield* Registry.Registry;
        const worktrees = yield* Worktrees.Worktrees;
        const [project] = yield* registry.projects;
        const registered =
          project ?? (yield* registry.register({ name: "proj", path: repo }));
        if (defaultBranch !== undefined) {
          yield* Effect.flatMap(Config.Config, (config) =>
            config.set(
              {
                kind: "project",
                projectId: registered.id,
                path: registered.path,
              },
              "defaultBranch",
              defaultBranch,
            ),
          );
        }
        const { primaryRef, primaryBranch } =
          yield* worktrees.primaryTarget(registered);
        return { primaryRef, primaryBranch };
      }),
    );
  assert.deepEqual(await targetWith(undefined), {
    primaryRef: "origin/main",
    primaryBranch: "main",
  });
  assert.deepEqual(await targetWith("gone/trunk"), {
    primaryRef: "gone/trunk",
    primaryBranch: "trunk",
  });
  assert.deepEqual(await targetWith("origin/feat"), {
    primaryRef: "origin/feat",
    primaryBranch: "origin/feat",
  });
});

it(
  "the owner's setup, its postinstall leaving a watcher on its output, finishes with the watcher still running",
  { timeout: 180_000 },
  async () => {
    const sandboxed = sandbox();
    box = sandboxed;
    const repo = sandboxed.realRepo("shigoto-no-mori");
    const watchers = join(sandboxed.home, "watchers");
    // This repository's own postinstall, then a watcher that keeps writing
    // to the script's output, as a dev server or a file watcher does: past
    // the create's own limit, and ending by itself after.
    const manifest = join(repo, "package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts["postinstall"] =
      `${pkg.scripts["postinstall"]} && ((for i in $(seq 3000); do echo watching; sleep 0.05; done) & echo $! >> '${watchers}')`;
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
    sandboxed.git(repo, "commit", "-q", "-am", "A watcher after postinstall");
    // From the store this checkout installed from, and without the
    // dependencies' build scripts (Electron's download): the install a
    // setup makes, never the network's.
    const saved = {
      offline: process.env["npm_config_offline"],
      ignoreScripts: process.env["npm_config_ignore_scripts"],
    };
    process.env["npm_config_offline"] = "true";
    process.env["npm_config_ignore_scripts"] = "true";
    const said: string[] = [];
    const restore = () => {
      for (const [key, value] of [
        ["npm_config_offline", saved.offline],
        ["npm_config_ignore_scripts", saved.ignoreScripts],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    const created = (await sandboxed
      .engine(
        Effect.gen(function* () {
          const project = yield* (yield* Registry.Registry).register({
            name: "shigoto-no-mori",
            path: repo,
          });
          yield* (yield* Config.Config).set(
            { kind: "project", projectId: project.id, path: project.path },
            "scripts.setup",
            "pnpm install && pnpm run postinstall",
          );
          return yield* (yield* Worktrees.Worktrees).create(
            project,
            { name: "fox" },
            {
              report: (event) =>
                Effect.sync(() => {
                  if (event.event === "script" && event.kind === "data") {
                    said.push(event.data);
                  }
                }),
              color: false,
            },
          );
        }).pipe(Effect.timeout("90 seconds")),
      )
      .finally(restore)) as {
      worktree?: Worktrees.WorktreeRow;
      error?: string;
    };
    const pids = existsSync(watchers)
      ? readFileSync(watchers, "utf8").trim().split("\n").map(Number)
      : [];
    try {
      assert.equal(created.error, undefined, said.join("").slice(-2000));
      assert.equal(created.worktree?.branch, "fox");
      assert.match(said.join(""), /\[icons\] synced[\s\S]*watching/);
      assert.ok(pids.length > 0 && pids.every((pid) => pid > 0));
      assert.doesNotThrow(() => process.kill(pids.at(-1) ?? 0, 0));
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Gone already: a watcher ends by itself.
        }
      }
    }
  },
);
