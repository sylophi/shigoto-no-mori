// Durable proof for the host's worktree rename against a REAL git
// repository: a script the app runs in the worktree refuses it, by
// name, and once the script is stopped the folder moves to its new name
// under a new id, with the page's row read back the way the app reads
// it.
//
// Run: pnpm test worktree-rename.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/adapters.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";

const fixture = cliSandbox("sm-rename-");
beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
});
afterAll(() => fixture.remove());
const { dataDir, git, commitFile, sandbox } = fixture;

const { listWorktrees } = await import("../host/lib/engineCalls.ts");
const { worktreesHandlers } = await import("../host/ipc/modules/worktrees.ts");
const { killScriptsForWorktree, startScript } =
  await import("../host/lib/scripts/index.ts");

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
    startScript({
      command: 'node -e "setTimeout(() => {}, 30000)"',
      slot: { kind: "package", name: "sleep" },
      worktree: { id: row.id, name: "fox", branch: "fox", path: worktree },
      project: { id: projectId, path: project, name: "project" },
      scriptEnv: {
        projectBranch: "main",
        defaultBranch: "main",
        title: "",
        description: "",
      },
      notify: () => {},
    }),
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
    await runHost(killScriptsForWorktree(row.id));
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
