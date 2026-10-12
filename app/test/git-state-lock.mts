// Durable proof for the mirror's git apply (host/mirror/gitState.ts)
// meeting a REAL index.lock: another git holding the index (an editor's
// integration, a prompt's `git status`) makes `read-tree` fail on the
// lock, and the apply waits through its backoff and lands once the lock
// goes. A lock held past the whole backoff fails the apply in git's own
// words.
//
// Run: pnpm test git-state-lock.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Project } from "@shigomori/contracts/schemas";
import * as Git from "@shigomori/engine/Git";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterAll, it } from "vitest";
import { errorWordsOf } from "@host/lib/errorWords";
import { applyGitState, readGitState } from "@host/mirror/gitState";
import {
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

// The apply runs git in this process.
scrubProcessGitEnv({
  GIT_AUTHOR_NAME: "sm",
  GIT_AUTHOR_EMAIL: "sm@example.test",
  GIT_COMMITTER_NAME: "sm",
  GIT_COMMITTER_EMAIL: "sm@example.test",
});
const git = sandboxGit();
const runtime = ManagedRuntime.make(
  Git.layer.pipe(Layer.provideMerge(NodeServices.layer)),
);
afterAll(() => runtime.dispose());

// A repository whose index stages one edit, the state an apply would
// carry, then put back to HEAD so the apply has something to move.
async function staged() {
  const repo = tempDir("sm-git-state-lock-", trackTest);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "a");
  writeFileSync(join(repo, "a.txt"), "staged\n");
  git(repo, "add", "a.txt");
  const wanted = await runtime.runPromise(readGitState(repo, repo, "wt"));
  git(repo, "reset", "-q");
  const current = await runtime.runPromise(readGitState(repo, repo, "wt"));
  assert.notEqual(current.indexTree, wanted.indexTree);
  // As a project the apply reads only its path.
  const project = { path: repo } as Project;
  const apply = () =>
    runtime.runPromise(
      applyGitState(
        project,
        { id: "wt", path: repo },
        { expect: current, state: wanted },
      ),
    );
  return { repo, wanted, apply };
}

const indexTree = (repo: string) => git(repo, "write-tree").trim();

// The apply's git through a wrapper that notes each `read-tree` it
// starts, for the length of the test, so the lock goes only once the
// apply has met it.
function countReadTrees(): () => number {
  const dir = tempDir("sm-git-wrapper-", trackTest);
  mkdirSync(dir, { recursive: true });
  const notes = join(dir, "read-trees");
  writeFileSync(notes, "");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\ncase " $* " in *" read-tree "*) echo x >> '${notes}';; esac\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  trackTest(() => {
    process.env.PATH = path;
  });
  return () => readFileSync(notes, "utf8").split("\n").filter(Boolean).length;
}

it("a held index.lock is waited out, and the apply lands once it goes", async () => {
  const { repo, wanted, apply } = await staged();
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  trackTest(() => rmSync(lock, { force: true }));
  const readTrees = countReadTrees();
  const applied = apply();
  // A second read-tree means the first one failed on the lock.
  await waitFor(() => readTrees() >= 2, "a read-tree retried on the lock");
  rmSync(lock);
  assert.deepEqual(await applied, { applied: true });
  assert.equal(indexTree(repo), wanted.indexTree);
});

it("a lock held past the whole backoff fails the apply in git's words", async () => {
  const { repo, apply } = await staged();
  const lock = join(repo, ".git", "index.lock");
  writeFileSync(lock, "");
  trackTest(() => rmSync(lock, { force: true }));
  const error = await apply().then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error !== null, "the apply went through a held lock");
  assert.match(errorWordsOf(error), /index\.lock/);
});
