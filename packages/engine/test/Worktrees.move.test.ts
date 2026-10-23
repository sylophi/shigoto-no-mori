// The re-key of a worktree's dirty capture, which the data-folder move
// and its undo run: a capture is never written over or taken for none,
// and one that can't follow stays where it was (real git on a sandbox
// data dir).
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { afterEach, beforeEach, it } from "vitest";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// A dirty capture whose ref can't follow (a lock git left on it) fails
// the re-key; asked again, the re-key carries it.
it("fails a re-key whose dirty capture can't follow, and carries it when asked again", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const from = "aaaaaaaaaaaa";
      const toPath = join(box.home, "elsewhere", "fox");
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, head);
      const to = worktreeIdFromPath(toPath);
      const lock = join(
        repo,
        ".git",
        "refs",
        "shigomori",
        "dirty",
        `${to}.lock`,
      );
      mkdirSync(join(repo, ".git", "refs", "shigomori", "dirty"), {
        recursive: true,
      });
      writeFileSync(lock, "");
      const first = yield* Effect.flip(worktrees.rekey(project, from, toPath));
      rmSync(lock);
      yield* worktrees.rekey(project, from, toPath);
      return {
        refused: Predicate.isTagged(first, "CaptureNotCarried"),
        carried:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${to}`).trim() ===
          head,
      };
    }),
  )) as { refused: boolean; carried: boolean };
  assert.ok(result.refused);
  assert.ok(result.carried);
});

// A capture kept under the new id from before (an earlier worktree at
// that path) is never written over: the re-key leaves the worktree's own
// under its old id, and the re-key back, an undo's, leaves both as they
// were.
it("never writes a capture over one kept under the id it re-keys to, either way", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const own = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "commit", "-q", "--allow-empty", "-m", "stale");
      const stale = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, own);
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, stale);
      const forward = yield* Effect.flip(
        worktrees.rekey(project, from, toPath),
      );
      yield* worktrees.rekey(project, to, fromPath, {
        expect: own,
        back: true,
      });
      const tip = (id: string) =>
        box.git(repo, "rev-parse", `refs/shigomori/dirty/${id}`).trim();
      return {
        occupied: forward.reason === "occupied",
        own: tip(from) === own,
        stale: tip(to) === stale,
      };
    }),
  )) as { occupied: boolean; own: boolean; stale: boolean };
  assert.deepEqual(result, { occupied: true, own: true, stale: true });
});

// An undo's re-key back carries the capture its re-key found and no
// other: one kept under the new id from before stays there, though the
// old id holds none.
it("carries back only the capture the re-key found, none when it found none", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const stale = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, stale);
      yield* worktrees.rekey(project, from, toPath);
      yield* worktrees.rekey(project, to, fromPath, {
        expect: null,
        back: true,
      });
      const has = (id: string) =>
        box
          .git(
            repo,
            "for-each-ref",
            "--format=%(objectname)",
            `refs/shigomori/dirty/${id}`,
          )
          .trim();
      return { from: has(from), to: has(to) };
    }),
  )) as { from: string; to: string };
  const stale = box.git(repo, "rev-parse", "HEAD").trim();
  assert.deepEqual(result, { from: "", to: stale });
});

it("fails a re-key whose capture changed since its caller looked, the capture left in place", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${from}`, head);
      const refused = yield* Effect.flip(
        worktrees.rekey(project, from, toPath, { expect: null }),
      );
      return {
        reason: refused.reason,
        kept:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${from}`).trim() ===
          head,
      };
    }),
  )) as { reason: string; kept: boolean };
  assert.deepEqual(result, { reason: "changed", kept: true });
});

// A capture git can't open is a failure, never taken for none, so an
// undo can't settle over it and lose track of it.
it("fails a re-key back whose capture can't be read, and carries it once it can", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, head);
      const loose = join(repo, ".git", "refs", "shigomori", "dirty", to);
      chmodSync(loose, 0o000);
      const first = yield* Effect.flip(
        worktrees.rekey(project, to, fromPath, { expect: head, back: true }),
      );
      chmodSync(loose, 0o644);
      yield* worktrees.rekey(project, to, fromPath, {
        expect: head,
        back: true,
      });
      return {
        reason: first.reason,
        back:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${from}`).trim() ===
          head,
      };
    }),
  )) as { reason: string; back: boolean };
  assert.deepEqual(result, { reason: "failed", back: true });
});

// A packed-refs git can't parse is a failure too, never a capture taken
// for none.
it("fails a re-key back over a packed-refs git can't parse, and carries it once git can", async () => {
  const repo = box.repo("proj", { "README.md": "hi\n" });
  const result = (await box.engine(
    Effect.gen(function* () {
      const registry = yield* Registry.Registry;
      const worktrees = yield* Worktrees.Worktrees;
      const project = yield* registry.register({ name: "proj", path: repo });
      const fromPath = join(box.home, "here", "fox");
      const toPath = join(box.home, "elsewhere", "fox");
      const from = worktreeIdFromPath(fromPath);
      const to = worktreeIdFromPath(toPath);
      const head = box.git(repo, "rev-parse", "HEAD").trim();
      box.git(repo, "update-ref", `refs/shigomori/dirty/${to}`, head);
      box.git(repo, "pack-refs", "--all");
      const packed = join(repo, ".git", "packed-refs");
      const whole = readFileSync(packed, "utf8");
      writeFileSync(packed, `${whole}garbage line\n`);
      const first = yield* Effect.flip(
        worktrees.rekey(project, to, fromPath, { expect: head, back: true }),
      );
      writeFileSync(packed, whole);
      yield* worktrees.rekey(project, to, fromPath, {
        expect: head,
        back: true,
      });
      return {
        reason: first.reason,
        back:
          box.git(repo, "rev-parse", `refs/shigomori/dirty/${from}`).trim() ===
          head,
      };
    }),
  )) as { reason: string; back: boolean };
  assert.deepEqual(result, { reason: "failed", back: true });
});
