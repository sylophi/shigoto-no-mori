// A data dir reached through a symlink (/tmp on macOS, or a data dir
// linked to another drive), where git lists worktrees under the
// resolved path: `worktrees create` and the doctor's drift checks
// (real git on a sandbox).
import assert from "node:assert/strict";
import {
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
import { afterEach, it, vi } from "vitest";
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
  "the owner's setup, then a watcher pnpm runs on its output, finishes with the watcher still running",
  { timeout: 180_000 },
  async () => {
    const sandboxed = sandbox();
    box = sandboxed;
    const repo = sandboxed.realRepo("shigoto-no-mori");
    const watchers = join(sandboxed.home, "watchers");
    // A watcher the setup starts after the owner's install, through pnpm,
    // that keeps writing to the script's output, as a dev server or a
    // file watcher does: past the create's own limit, and ending by
    // itself after. Not in the postinstall, which an install runs too and
    // pnpm waits out.
    const manifest = join(repo, "package.json");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts["watch"] =
      `echo $$ $PPID >> '${watchers}'; for i in $(seq 3000); do echo watching; sleep 0.05; done`;
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
    sandboxed.git(repo, "commit", "-q", "-am", "A watcher");
    // From the store this checkout installed from, and without the
    // dependencies' build scripts (Electron's download): the install a
    // setup makes, never the network's. Both prefixes, as pnpm reads
    // either.
    const settings = [
      "npm_config_offline",
      "npm_config_ignore_scripts",
      "pnpm_config_offline",
      "pnpm_config_ignore_scripts",
    ] as const;
    const saved = settings.map((key) => [key, process.env[key]] as const);
    for (const key of settings) process.env[key] = "true";
    const said: string[] = [];
    const restore = () => {
      for (const [key, value] of saved) {
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
            "pnpm install && pnpm run postinstall && (pnpm run watch &)",
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
    // The watcher and its pnpm, once pnpm has started it.
    const pids = await vi
      .waitFor(
        () => {
          const [pid = 0, parent = 0] = readFileSync(watchers, "utf8")
            .trim()
            .split(" ")
            .map(Number);
          assert.ok(pid > 0 && parent > 0);
          return [pid, parent];
        },
        { timeout: 20_000, interval: 100 },
      )
      .catch(() => []);
    try {
      assert.equal(created.error, undefined, said.join("").slice(-2000));
      assert.equal(created.worktree?.branch, "fox");
      assert.match(said.join(""), /\[icons\] synced/);
      assert.equal(pids.length, 2, "the watcher never started");
      for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0));
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
