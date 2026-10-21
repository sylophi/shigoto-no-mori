// Durable proof for the host's worktree rename against a REAL git
// repository: a script the app runs in the worktree refuses it, by
// name, and once the script is stopped the folder moves to its new name
// under a new id, with the page's row read back the way the app reads
// it. A call by the id from before the move (a stale window's, a
// peer's) lands on the worktree it became and describes it.
//
// Run: pnpm test worktree-rename.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { scriptEnv } from "./lib/checkKit.mts";

const fixture = cliSandbox("sm-rename-");
beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
});
afterAll(() => fixture.remove());
const { dataDir, git, commitFile, sandbox } = fixture;

const Ops = await import("../host/lib/engineOps.ts");
const listWorktrees = (projectId: string) =>
  runHost(Ops.listWorktrees(projectId));
const { worktreesHandlers } = await import("../host/ipc/modules/worktrees.ts");
const { Scripts } = await import("../host/lib/Scripts.ts");

it("refuses while a script runs there, then renames under a new id", async () => {
  const project = join(sandbox, "project");
  await git(sandbox, ["init", "-q", "-b", "main", project]);
  await commitFile(project, "a.txt", "a\n", "seed");
  const worktree = join(dataDir, "wt", basename(project), "fox");
  await git(project, ["worktree", "add", "-q", "-b", "fox", worktree]);
  const projectId = await fixture.projectIdOf(project);
  const row = (await listWorktrees(projectId)).find((w) => w.path === worktree);
  assert.ok(row, "the worktree is listed");

  await runHost(
    Effect.flatMap(Scripts, (scripts) =>
      scripts.start({
        command: 'node -e "setTimeout(() => {}, 30000)"',
        slot: { kind: "package", name: "sleep" },
        worktree: { id: row.id, name: "fox", branch: "fox", path: worktree },
        project: { id: projectId, path: project, name: "project" },
        scriptEnv,
        notify: () => {},
      }),
    ),
  );
  try {
    await assert.rejects(
      async () =>
        runHost(
          worktreesHandlers.rename({
            projectId,
            worktreeId: row.id,
            name: "otter",
          }),
        ),
      /Can't rename fox while 1 script is running there\. Stop it first\./,
    );
    assert.ok(existsSync(worktree), "a refused rename moves nothing");
  } finally {
    await runHost(
      Effect.flatMap(Scripts, (scripts) => scripts.stopWorktree(row.id)),
    );
  }

  const renamed = await runHost(
    worktreesHandlers.rename({ projectId, worktreeId: row.id, name: "otter" }),
  );
  assert.equal(renamed.path, join(dirname(worktree), "otter"));
  assert.equal(renamed.name, "otter");
  assert.notEqual(renamed.id, row.id);
  assert.ok(!existsSync(worktree));
  const listed = new Set((await listWorktrees(projectId)).map((w) => w.id));
  assert.ok(listed.has(renamed.id));
  assert.ok(!listed.has(row.id));
});

it("a call by an id from before a move lands on the moved worktree and describes it", async () => {
  const project = join(sandbox, "moved");
  await git(sandbox, ["init", "-q", "-b", "main", project]);
  await commitFile(project, "a.txt", "a\n", "seed");
  const worktree = join(dataDir, "wt", basename(project), "badger");
  await git(project, ["worktree", "add", "-q", "-b", "badger", worktree]);
  const projectId = await fixture.projectIdOf(project);
  const before = (await listWorktrees(projectId)).find(
    (w) => w.path === worktree,
  );
  assert.ok(before, "the worktree is listed");
  const renamed = await runHost(
    worktreesHandlers.rename({
      projectId,
      worktreeId: before.id,
      name: "stoat",
    }),
  );

  const branched = await runHost(
    worktreesHandlers.renameBranch({
      projectId,
      worktreeId: before.id,
      newBranch: "stoat",
    }),
  );
  assert.equal(branched.id, renamed.id);
  assert.equal(branched.branch, "stoat");

  const shelved = await runHost(
    worktreesHandlers.setShelved({
      projectId,
      worktreeId: before.id,
      shelved: true,
    }),
  );
  assert.equal(shelved.id, renamed.id);
  assert.equal(shelved.shelved, true);

  const destination = join(dirname(worktree), "weasel");
  const relocated = await runHost(
    worktreesHandlers.relocate({
      projectId,
      worktreeId: before.id,
      destinationPath: destination,
    }),
  );
  assert.equal(relocated.path, destination);
  assert.ok(!existsSync(renamed.path));
});

it("relocating the primary is the engine's refusal, whatever runs there", async () => {
  const project = join(sandbox, "primary");
  await git(sandbox, ["init", "-q", "-b", "main", project]);
  await commitFile(project, "a.txt", "a\n", "seed");
  const projectId = await fixture.projectIdOf(project);
  const primary = (await listWorktrees(projectId)).find((w) => w.isPrimary);
  assert.ok(primary, "the primary is listed");
  await runHost(
    Effect.flatMap(Scripts, (scripts) =>
      scripts.start({
        command: 'node -e "setTimeout(() => {}, 30000)"',
        slot: { kind: "package", name: "sleep" },
        worktree: {
          id: primary.id,
          name: primary.name,
          branch: "main",
          path: project,
        },
        project: { id: projectId, path: project, name: "primary" },
        scriptEnv,
        notify: () => {},
      }),
    ),
  );
  try {
    await assert.rejects(
      runHost(
        worktreesHandlers.relocate({
          projectId,
          worktreeId: primary.id,
          destinationPath: join(sandbox, "elsewhere"),
        }),
      ),
      /The primary checkout can't be moved/,
    );
  } finally {
    await runHost(
      Effect.flatMap(Scripts, (scripts) => scripts.stopWorktree(primary.id)),
    );
  }
});
