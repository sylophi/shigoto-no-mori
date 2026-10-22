// A project's worktree list: git's `worktree list` answered again while
// the files it reads say the same, so reads with nothing changed run no
// git, a commit on a branch (which moves no identity) runs none, and
// each change an identity shows (a branch, a detach, a lock, the
// primary's checkout, a worktree added, moved, removed or pruned) is in
// the very next read, a change made while git runs included, undone by
// the time it answers or after, as far as the files show it (real git
// on a sandbox data dir).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

type Shown = Pick<
  Worktrees.WorktreeIdentity,
  "name" | "branch" | "path" | "detached" | "locked"
>;

const named = (read: ReadonlyArray<Shown>, name: string) =>
  read.find((worktree) => worktree.name === name);

it("lists a project's worktrees with git once while its files say the same, and again on each change an identity shows", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const fox = join(box.home, "elsewhere", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  // Every `git worktree list` from here on, counted, with a command run
  // once just before git reads and once just after, when one is set.
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const log = join(box.home, "worktree-lists.log");
  const beforeGit = join(box.home, "before.sh");
  const afterGit = join(box.home, "after.sh");
  box.fakeBin(
    "git",
    [
      `case " $* " in *" worktree list "*)`,
      `  echo >> "${log}"`,
      `  if [ -f "${beforeGit}" ]; then sh "${beforeGit}"; rm "${beforeGit}"; fi`,
      `  "${realGit}" "$@"; code=$?`,
      `  if [ -f "${afterGit}" ]; then sh "${afterGit}"; rm "${afterGit}"; fi`,
      `  exit $code ;;`,
      `esac`,
      `exec "${realGit}" "$@"`,
    ].join("\n"),
  );
  const lists = () => (existsSync(log) ? readFileSync(log, "utf8").length : 0);
  const project = (await box.engine(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "proj", path: repo }),
    ),
  )) as Registry.RegisteredProject;
  // The next read, and how many times git listed for it.
  const next = async () => {
    const before = lists();
    const found = (await box.engine(
      Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
        worktrees.identities(project),
      ),
    )) as ReadonlyArray<Worktrees.WorktreeIdentity>;
    const read = found.map(
      ({ name, branch, path, detached, locked }): Shown => ({
        name,
        branch,
        path,
        detached,
        locked,
      }),
    );
    return { read, listed: lists() - before };
  };
  const change = async (what: string, run: () => void) => {
    run();
    const { read, listed } = await next();
    assert.equal(listed, 1, `${what}: read again`);
    return read;
  };
  const tip = (at: string) => box.git(at, "rev-parse", "HEAD").trim();

  const { read: settled } = await next();
  assert.deepEqual(await next(), { read: settled, listed: 0 }, "no change");
  box.git(fox, "commit", "-q", "--allow-empty", "-m", "two");
  assert.deepEqual(await next(), { read: settled, listed: 0 }, "a commit");

  let read = await change("a branch switch", () =>
    box.git(fox, "checkout", "-q", "-b", "fox2"),
  );
  assert.equal(named(read, "fox")?.branch, "fox2");
  read = await change("a detach", () =>
    box.git(fox, "checkout", "-q", "--detach"),
  );
  assert.deepEqual(named(read, "fox"), {
    name: "fox",
    branch: tip(fox).slice(0, 7),
    path: fox,
    detached: true,
    locked: false,
  });
  read = await change("a commit on a detached HEAD", () =>
    box.git(fox, "commit", "-q", "--allow-empty", "-m", "three"),
  );
  assert.equal(named(read, "fox")?.branch, tip(fox).slice(0, 7));
  read = await change("a lock", () => box.git(repo, "worktree", "lock", fox));
  assert.equal(named(read, "fox")?.locked, true);
  read = await change("an unlock", () =>
    box.git(repo, "worktree", "unlock", fox),
  );
  assert.equal(named(read, "fox")?.locked, false);
  // A switch just after git read: the files were read before it.
  writeFileSync(afterGit, `"${realGit}" -C "${fox}" checkout -q -b fox3`);
  read = await change("a lock, with a switch after git", () =>
    box.git(repo, "worktree", "lock", fox),
  );
  assert.equal(named(read, "fox")?.detached, true);
  read = await change("the switch", () => {});
  assert.deepEqual(
    [named(read, "fox")?.detached, named(read, "fox")?.branch],
    [false, "fox3"],
  );
  // A detach that git reads and that is undone by the time it answers:
  // HEAD says what it said, but in a new file.
  writeFileSync(beforeGit, `"${realGit}" -C "${fox}" checkout -q --detach`);
  writeFileSync(afterGit, `"${realGit}" -C "${fox}" checkout -q fox3`);
  read = await change("an unlock, with a detach and back around git", () =>
    box.git(repo, "worktree", "unlock", fox),
  );
  assert.equal(named(read, "fox")?.detached, true);
  read = await change("the detach undone", () => {});
  assert.deepEqual(
    [named(read, "fox")?.detached, named(read, "fox")?.branch],
    [false, "fox3"],
  );
  // A lock taken as git reads: in git's answer, not in the files read
  // before it, which read the same again once it's released, so the
  // answer isn't kept.
  writeFileSync(beforeGit, `"${realGit}" -C "${repo}" worktree lock "${fox}"`);
  read = await change("a lock while git reads", () => {
    box.git(fox, "checkout", "-q", "-b", "fox4");
  });
  assert.equal(named(read, "fox")?.locked, true);
  read = await change("the lock released", () =>
    box.git(repo, "worktree", "unlock", fox),
  );
  assert.equal(named(read, "fox")?.locked, false);
  // A worktree git reads that is gone by the time it answers: its
  // folder's name came and went.
  const ant = join(box.home, "elsewhere", "ant");
  writeFileSync(
    beforeGit,
    `"${realGit}" -C "${repo}" worktree add -q -b ant "${ant}"`,
  );
  writeFileSync(afterGit, `"${realGit}" -C "${repo}" worktree remove "${ant}"`);
  read = await change("a worktree there only while git reads", () => {
    box.git(fox, "checkout", "-q", "-b", "fox5");
  });
  assert.equal(named(read, "ant")?.path, ant);
  read = await change("the worktree gone", () => {});
  assert.equal(named(read, "ant"), undefined);
  read = await change("the primary's checkout", () =>
    box.git(repo, "checkout", "-q", "-b", "other"),
  );
  assert.equal(named(read, "proj")?.branch, "other");
  const owl = join(box.home, "elsewhere", "owl");
  read = await change("a worktree added", () =>
    box.git(repo, "worktree", "add", "-q", "-b", "owl", owl),
  );
  assert.equal(named(read, "owl")?.path, owl);
  const kit = join(box.home, "elsewhere", "kit");
  read = await change("a worktree moved", () =>
    box.git(repo, "worktree", "move", owl, kit),
  );
  assert.deepEqual(
    [named(read, "owl"), named(read, "kit")?.path],
    [undefined, kit],
  );
  read = await change("a worktree removed", () =>
    box.git(repo, "worktree", "remove", kit),
  );
  assert.equal(named(read, "kit"), undefined);
  // A worktree's folder deleted by hand stays listed, by git too, until
  // a prune drops its entry.
  const elk = join(box.home, "elsewhere", "elk");
  read = await change("another worktree added", () =>
    box.git(repo, "worktree", "add", "-q", "-b", "elk", elk),
  );
  rmSync(elk, { recursive: true, force: true });
  assert.deepEqual(await next(), { read, listed: 0 }, "its folder deleted");
  read = await change("a prune", () => box.git(repo, "worktree", "prune"));
  assert.equal(named(read, "elk"), undefined);
  assert.equal((await next()).listed, 0, "no change after");
});

it("a checkout stopped mid-rebase keeps its branch, the primary and a linked one alike", async () => {
  const repo = box.repo("proj", { "README.md": "base\n" });
  const fox = join(box.home, "elsewhere", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  // Both change the same line, so each rebase stops on it: the linked
  // one's with git's default backend, the primary's with the other.
  writeFileSync(join(fox, "README.md"), "fox\n");
  box.git(fox, "commit", "-q", "-am", "fox");
  box.git(repo, "checkout", "-q", "-b", "side");
  writeFileSync(join(repo, "README.md"), "side\n");
  box.git(repo, "commit", "-q", "-am", "side");
  assert.throws(() => box.git(fox, "rebase", "side"));
  assert.throws(() => box.git(repo, "rebase", "--apply", "fox"));
  const project = (await box.engine(
    Effect.flatMap(Registry.Registry, (registry) =>
      registry.register({ name: "proj", path: repo }),
    ),
  )) as Registry.RegisteredProject;
  const read = (await box.engine(
    Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
      worktrees.identities(project),
    ),
  )) as ReadonlyArray<Worktrees.WorktreeIdentity>;
  assert.deepEqual(
    read.map(({ name, branch, detached }) => ({ name, branch, detached })),
    [
      { name: "proj", branch: "side", detached: false },
      { name: "fox", branch: "fox", detached: false },
    ],
  );
});
