// Files git would replace or delete without a word: a hard reset keeps
// them in its snapshot, a fast-forward leaves them where they are, and
// a pop takes the stash it was asked for.
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

  await withGit((git) => git.applyStash({ worktree: repo, hash, drop: true }));
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "asked for\n");
  assert.equal(readFileSync(join(repo, "b.txt"), "utf8"), "b\n");
  assert.equal(box.git(repo, "stash", "list").trim().split("\n").length, 1);
});
