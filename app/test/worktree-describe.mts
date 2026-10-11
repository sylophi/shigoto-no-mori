// Durable proof for the worktree page's title and description edits
// against a REAL git repository: the host's describe goes through the
// engine's (`sm describe`'s), a dash-led text included, one left out
// stays, and an empty one clears it, answered with the page's row.
//
// Run: pnpm test worktree-describe.
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";

const fixture = cliSandbox("sm-describe-");
beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
});
afterAll(() => fixture.remove());
const { dataDir, git, commitFile, sandbox } = fixture;

const Ops = await import("../host/lib/engineOps.ts");
const { worktreesHandlers } = await import("../host/ipc/modules/worktrees.ts");

it("sets the title and description, a dash-led text included, and clears one left empty", async () => {
  const project = join(sandbox, "project");
  await git(sandbox, ["init", "-q", "-b", "main", project]);
  await commitFile(project, "a.txt", "a\n", "seed");
  const worktree = join(dataDir, "wt", basename(project), "fox");
  await git(project, ["worktree", "add", "-q", "-b", "fox", worktree]);
  const projectId = await fixture.projectIdOf(project);
  const row = (await runHost(Ops.listWorktrees(projectId))).find(
    (w) => w.path === worktree,
  );
  assert.ok(row, "the worktree is listed");

  const described = await runHost(
    worktreesHandlers.describe({
      projectId,
      worktreeId: row.id,
      title: "-t edited",
      description: "- one\n- two",
    }),
  );
  assert.equal(described.title, "-t edited");
  assert.equal(described.description, "- one\n- two");

  const cleared = await runHost(
    worktreesHandlers.describe({ projectId, worktreeId: row.id, title: "" }),
  );
  assert.equal(cleared.title, undefined);
  assert.equal(cleared.description, "- one\n- two");
});
