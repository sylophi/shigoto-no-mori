// Durable proof for the app's finish (host/lib/engineOps.ts
// finishWorktree, the merged PR box on a primary checkout), over a clone
// of this repository and a scripted gh.
//
// Asserts:
//   - a branch that holds a commit its merged PR doesn't is refused by
//     `done`'s own proof, the checkout still on it and the branch kept,
//   - the same branch, held whole by the PR, is finished: the checkout
//     back on main and the branch deleted.
//
// Run: pnpm test finish-branch.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "@shigomori/contracts/schemas";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, it } from "vitest";
import * as Ops from "../host/lib/engineOps.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { initDataDirAt } from "../shared/paths.ts";
import {
  installFakeGh,
  makeTracker,
  repoRoot,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";

scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let root: string;
let repo: string;
let headFile: string;
let project: Project;

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  root = tempDir("sm-finish-branch-", track);
  // An upstream holding this repository's checked-out commit as main,
  // and a clone of it: origin/main tracked, as a user's project is.
  const upstream = join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", "--shared", repoRoot, upstream);
  git(
    upstream,
    "update-ref",
    "refs/heads/main",
    git(repoRoot, "rev-parse", "HEAD").trim(),
  );
  repo = join(root, "shigoto-no-mori");
  git(root, "clone", "-q", "--branch", "main", upstream, repo);
  headFile = join(root, "pr-5-head");
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
  "pr list --state merged --head fox "*) printf '[{"number":5,"isCrossRepository":false,"headRefOid":"%s"}]' "$(cat '${headFile}')";;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    track,
  );
  project = await runHost(addProject(repo));
});
afterAll(teardown);

// The primary checkout on fox, a commit ahead of main and pushed: PR
// #5's head, which GitHub merged by squash, so main holds none of it.
const onMergedBranch = () => {
  git(repo, "checkout", "-q", "-B", "fox", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "fox");
  git(repo, "push", "-q", "--force", "origin", "fox");
  writeFileSync(headFile, git(repo, "rev-parse", "HEAD").trim());
};

it("a branch with a commit its merged PR doesn't have is refused and kept", async () => {
  onMergedBranch();
  git(repo, "commit", "-q", "--allow-empty", "-m", "late");
  const failed = await runHost(
    Ops.finishWorktree(project, worktreeIdFromPath(repo)).pipe(Effect.flip),
  );
  assert.match(
    String(failed.message),
    /^Branch fox has a commit its merged PR #5 never had/,
  );
  assert.equal(git(repo, "branch", "--show-current").trim(), "fox");
  assert.match(git(repo, "log", "-1", "--format=%s", "fox"), /^late/);
});

it("a branch its merged PR holds whole is finished", async () => {
  onMergedBranch();
  await runHost(Ops.finishWorktree(project, worktreeIdFromPath(repo)));
  assert.equal(git(repo, "branch", "--show-current").trim(), "main");
  assert.equal(git(repo, "branch", "--list", "fox").trim(), "");
});
