// Stashes for the Git section. The stash list belongs to the whole
// repository, shared by every worktree, so a worktree lists the ones
// made on its own branch. Each is addressed by its commit hash, since
// the stash@{n} positions shift whenever any worktree stashes or drops.
import type { StashEntry } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { onIndex } from "./changes";
import { GitRefusal, PATCH_MAX_BUFFER, run, splitZ } from "./core";
import { conflictedPaths } from "./operation";

interface RawStash {
  ref: string;
  hash: string;
  subject: string;
  date: string;
}

const readStashes = (worktreePath: string) =>
  Effect.map(
    run(worktreePath, [
      "stash",
      "list",
      "-z",
      "--format=%gd%x00%h%x00%gs%x00%cI",
    ]),
    (out) => {
      const fields = splitZ(out);
      const stashes: RawStash[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const [ref = "", hash = "", subject = "", date = ""] = fields.slice(
          i,
          i + 4,
        );
        stashes.push({ ref, hash, subject, date });
      }
      return stashes;
    },
  );

// Git words a stash's subject "On <branch>: <message>" when it was given
// one, and "WIP on <branch>: <hash> <subject>" when not.
function messageOn(
  subject: string,
  branch: string,
): { message: string; named: boolean } | null {
  const named = `On ${branch}: `;
  if (subject.startsWith(named)) {
    return { message: subject.slice(named.length), named: true };
  }
  const wip = `WIP on ${branch}: `;
  if (subject.startsWith(wip)) {
    const rest = subject.slice(wip.length);
    return { message: rest.slice(rest.indexOf(" ") + 1), named: false };
  }
  return null;
}

export const listStashes = (worktreePath: string, branch: string) =>
  Effect.map(readStashes(worktreePath), (stashes) =>
    stashes.flatMap(({ hash, subject, date }): StashEntry[] => {
      const parsed = messageOn(subject, branch);
      return parsed === null ? [] : [{ hash, ...parsed, date }];
    }),
  );

// Untracked files go too, so the worktree comes back clean, which is
// what a stash is for here.
export const stashChanges = (
  worktreePath: string,
  message: string | undefined,
) => {
  const args = ["stash", "push", "--include-untracked"];
  if (message?.trim()) args.push("-m", message.trim());
  return onIndex(worktreePath, Effect.asVoid(run(worktreePath, args)));
};

const refOf = (worktreePath: string, hash: string) =>
  Effect.flatMap(readStashes(worktreePath), (stashes) => {
    const stash = stashes.find((s) => s.hash === hash);
    return stash
      ? Effect.succeed(stash.ref)
      : Effect.fail(new GitRefusal({ reason: "That stash is gone." }));
  });

// With `drop`, a pop: the stash goes only once it applied cleanly. One
// that applied with conflicts stays, so nothing is lost while the
// conflicts are sorted out.
export const applyStash = (worktreePath: string, hash: string, drop: boolean) =>
  onIndex(
    worktreePath,
    Effect.gen(function* () {
      const ref = yield* refOf(worktreePath, hash);
      yield* run(worktreePath, [
        "stash",
        "apply",
        "--end-of-options",
        ref,
      ]).pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            if ((yield* conflictedPaths(worktreePath)).length === 0) {
              return yield* err;
            }
            return yield* new GitRefusal({
              reason:
                "The stash applied with conflicts. It's kept until they're resolved.",
            });
          }),
        ),
      );
      if (drop) yield* run(worktreePath, ["stash", "drop", "--quiet", ref]);
    }),
  );

export const dropStash = Effect.fnUntraced(function* (
  worktreePath: string,
  hash: string,
) {
  const ref = yield* refOf(worktreePath, hash);
  yield* run(worktreePath, ["stash", "drop", "--quiet", ref]);
});

// The way back from a drop: the stash's commit is still in the object
// store, and `stash store` lists it again, on top, under its subject as
// git words it. An unnamed one's names the stash itself where git's
// names the commit under it, which nothing here reads.
// store takes no --end-of-options, and needs none: the hash is
// schema-pinned hex.
export const restoreStash = (
  worktreePath: string,
  branch: string,
  hash: string,
  { message, named }: { message: string; named: boolean },
) =>
  Effect.asVoid(
    run(worktreePath, [
      "stash",
      "store",
      "-m",
      named
        ? `On ${branch}: ${message}`
        : `WIP on ${branch}: ${hash} ${message}`,
      hash,
    ]),
  );

// What a stash holds, as one patch: its tracked changes and the
// untracked files it took, as additions.
export const readStashDiff = Effect.fnUntraced(function* (
  worktreePath: string,
  hash: string,
) {
  const ref = yield* refOf(worktreePath, hash);
  return yield* run(
    worktreePath,
    ["stash", "show", "-p", "--include-untracked", "--no-color", ref],
    { maxBuffer: PATCH_MAX_BUFFER },
  );
});
