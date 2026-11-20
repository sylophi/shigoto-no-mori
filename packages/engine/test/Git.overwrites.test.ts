// Files git would replace or delete without a word: a hard reset keeps
// them in its snapshot, a fast-forward leaves them where they are, a
// pop takes the stash it was asked for, a sync leaves another
// program's merge be, and a discard it can't finish doesn't start.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "../src/canonicalPath.ts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Git from "../src/Git.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const withGit = <A, E>(use: (git: Git.Git["Service"]) => Effect.Effect<A, E>) =>
  box.engine(Effect.flatMap(Effect.service(Git.Git), use));

it("a hard reset snapshots a file added with intent to add, and the undo brings it back", async () => {
  const repo = box.repo("repo", { "a.txt": "a\n" });
  const draft = join(repo, "draft.txt");
  writeFileSync(draft, "not committed anywhere\n");
  box.git(repo, "add", "-N", "draft.txt");

  const reset = (await withGit((git) =>
    git.resetHard({ worktree: repo, ref: "HEAD" }),
  )) as { snapshot: string | null };
  assert.equal(existsSync(draft), false);
  assert.ok(reset.snapshot, JSON.stringify(reset));

  await withGit((git) =>
    git.restoreDiscard({ worktree: repo, snapshot: reset.snapshot ?? "" }),
  );
  assert.equal(readFileSync(draft, "utf8"), "not committed anywhere\n");
});

it("a fast-forward refuses to replace an ignored file the upstream starts tracking", async () => {
  const upstream = box.repo("upstream", { ".gitignore": "local.yml\n" });
  const clone = join(dirname(upstream), "clone");
  box.git(upstream, "clone", "-q", upstream, clone);
  const local = join(clone, "local.yml");
  writeFileSync(local, "mine\n");
  writeFileSync(join(upstream, "local.yml"), "theirs\n");
  box.git(upstream, "add", "-f", "local.yml");
  box.git(upstream, "commit", "-q", "-m", "track local.yml");
  box.git(clone, "fetch", "-q");

  const pulled = (await withGit((git) => git.fastForwardToUpstream(clone))) as
    | { ok?: boolean }
    | undefined;
  assert.equal(pulled?.ok, false, JSON.stringify(pulled));
  assert.equal(readFileSync(local, "utf8"), "mine\n");
});

// Another worktree stashes between the pop's look at the list and its
// apply, which moves every stash's place down one.
it("a pop applies and drops the stash it was asked for after another was pushed", async () => {
  const repo = box.repo("repo", { "a.txt": "a\n", "b.txt": "b\n" });
  writeFileSync(join(repo, "a.txt"), "asked for\n");
  box.git(repo, "stash", "push", "-q");
  const hash = box.git(repo, "stash", "list", "--format=%h").trim();
  const real = box.git(repo, "--exec-path").trim();
  const once = join(dirname(repo), "pushed");
  box.fakeBin(
    "git",
    `case "$*" in *"stash list"*)
  "${real}/git" "$@"; listed=$?
  if [ ! -e "${once}" ]; then
    : > "${once}"
    echo other >> "${repo}/b.txt"
    "${real}/git" -C "${repo}" stash push -q
  fi
  exit $listed;;
esac
exec "${real}/git" "$@"`,
  );

  const popped = await withGit((git) =>
    git.applyStash({ worktree: repo, hash, drop: true }),
  );
  assert.equal(popped, undefined, JSON.stringify(popped));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "asked for\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b\n");
  assert.equal(box.git(repo, "stash", "list").trim().split("\n").length, 1);
});

// Another program merges, stops on a conflict and starts resolving it
// while the sync fetches.
it("a sync leaves alone a merge another program stopped in during its fetch", async () => {
  const upstream = box.repo("upstream", { "a.txt": "a\n" });
  const clone = join(dirname(upstream), "clone");
  box.git(upstream, "clone", "-q", upstream, clone);
  box.git(clone, "checkout", "-q", "-b", "side");
  writeFileSync(join(clone, "a.txt"), "side\n");
  box.git(clone, "commit", "-q", "-am", "side");
  box.git(clone, "checkout", "-q", "main");
  writeFileSync(join(clone, "a.txt"), "main\n");
  box.git(clone, "commit", "-q", "-am", "main");
  const real = box.git(clone, "--exec-path").trim();
  const once = join(dirname(clone), "merged");
  box.fakeBin(
    "git",
    `case "$*" in *fetch*)
  "${real}/git" "$@"; fetched=$?
  if [ ! -e "${once}" ]; then
    : > "${once}"
    "${real}/git" -C "${clone}" merge -q side >/dev/null 2>&1
    echo resolved > "${clone}/a.txt"
  fi
  exit $fetched;;
esac
exec "${real}/git" "$@"`,
  );

  const synced = (await withGit((git) =>
    git.syncWithPrimary({
      worktree: clone,
      repo: clone,
      primaryRef: "origin/main",
    }),
  )) as { ok?: boolean } | undefined;
  assert.equal(synced?.ok, false, JSON.stringify(synced));
  assert.ok(existsSync(join(clone, ".git", "MERGE_HEAD")));
  assert.equal(readFileSync(join(clone, "a.txt"), "utf8"), "resolved\n");
});

it("a discard with a nested repository among its paths refuses before discarding the rest", async () => {
  const repo = box.repo("repo", { "a.txt": "a\n" });
  writeFileSync(join(repo, "a.txt"), "edited\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  const nested = box.repo("repo/nested");

  const discarded = (await withGit((git) =>
    git.discard({ worktree: repo, paths: ["a.txt", "new.txt", "nested/"] }),
  )) as { ok?: boolean } | undefined;
  assert.equal(discarded?.ok, false, JSON.stringify(discarded));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "edited\n");
  assert.equal(readFileSync(join(repo, "new.txt"), "utf8"), "new\n");
  assert.ok(existsSync(join(nested, ".git")));
});
