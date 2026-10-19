// Git's stashes for the Git section. The stash list belongs to the
// whole repository, shared by every worktree, so a worktree lists the
// ones made on its own branch. Each is addressed by its commit hash,
// since the stash@{n} positions shift whenever any worktree stashes or
// drops.
import type { StashEntry } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { splitZ } from "../gitParse.ts";
import {
  GitRefusedError,
  PATCH_CONFIG,
  PATCH_FLAGS,
  PATCH_MAX_OUTPUT,
} from "./documents.ts";
import type { OperationArea } from "./operation.ts";
import { indexHeld, type RunningArea, waitingForIndex } from "./running.ts";

// Git words a stash's subject "On <branch>: <message>" when it was
// given one, and "WIP on <branch>: <hash> <subject>" when not.
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

export const makeStash = ({
  running,
  operation,
}: {
  readonly running: RunningArea;
  readonly operation: OperationArea;
}) =>
  Effect.sync(() => {
    const { run, runLenient, onIndex } = running;
    const { conflictedPaths } = operation;

    const readStashes = (worktree: string) =>
      run(worktree, [
        "stash",
        "list",
        "-z",
        "--format=%gd%x00%h%x00%gs%x00%cI",
      ]).pipe(
        Effect.map((out) => {
          const fields = splitZ(out);
          const stashes: {
            ref: string;
            hash: string;
            subject: string;
            date: string;
          }[] = [];
          for (let i = 0; i + 3 < fields.length; i += 4) {
            const [ref = "", hash = "", subject = "", date = ""] = fields.slice(
              i,
              i + 4,
            );
            stashes.push({ ref, hash, subject, date });
          }
          return stashes;
        }),
      );

    const refOf = (worktree: string, hash: string) =>
      readStashes(worktree).pipe(
        Effect.flatMap((stashes) => {
          const stash = stashes.find((s) => s.hash === hash);
          return stash
            ? Effect.succeed(stash.ref)
            : Effect.fail(
                new GitRefusedError({ reason: "That stash is gone." }),
              );
        }),
      );

    const listStashes = Effect.fn("Git.listStashes")(function* (
      worktree: string,
      branch: string,
    ) {
      return (yield* readStashes(worktree)).flatMap(
        ({ hash, subject, date }): StashEntry[] => {
          const parsed = messageOn(subject, branch);
          return parsed === null ? [] : [{ hash, ...parsed, date }];
        },
      );
    });

    // Untracked files go too, so the worktree comes back clean, which is
    // what a stash is for here. Git saves the stash before it cleans the
    // worktree (`clean`, then `reset --hard`), so another program's git
    // holding index.lock for a moment (an editor's or a prompt's `git
    // status`) can refuse the reset with the stash saved. Refused before
    // saving, it changed nothing and is asked again. Refused after, its
    // cleanup is finished here, the reset waiting the lock out as every
    // one-step write does; never asked again, which would save it twice.
    const stashChanges = Effect.fn("Git.stashChanges")(function* (
      worktree: string,
      message: string | undefined,
    ) {
      const tip = runLenient(worktree, [
        "rev-parse",
        "-q",
        "--verify",
        "refs/stash",
      ]).pipe(Effect.map((out) => out.trim()));
      const cleanup = Effect.gen(function* () {
        yield* run(worktree, ["clean", "--force", "--quiet", "-d", ":/"]);
        yield* run(worktree, [
          "reset",
          "--hard",
          "-q",
          "--no-recurse-submodules",
        ]);
      }).pipe(
        Effect.mapError(
          () =>
            new GitRefusedError({
              reason:
                "It was saved to the stash list, but another program's git held the worktree's index, so the changes are also still here. Discard all changes, in the changes list's ⋯ menu, finishes it.",
            }),
        ),
      );
      const attempt = Effect.gen(function* () {
        const before = yield* tip;
        yield* run(worktree, [
          "stash",
          "push",
          "--include-untracked",
          ...(message?.trim() ? ["-m", message.trim()] : []),
        ]).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              if (!indexHeld(error) || (yield* tip) === before) {
                return yield* Effect.fail(error);
              }
              yield* cleanup;
            }),
          ),
        );
      });
      yield* onIndex(worktree, waitingForIndex(attempt));
    });

    // With `drop`, a pop: the stash goes only once it applied cleanly.
    // One that applied with conflicts stays, so nothing is lost while the
    // conflicts are sorted out.
    const applyStash = Effect.fn("Git.applyStash")(function* (input: {
      readonly worktree: string;
      readonly hash: string;
      readonly drop: boolean;
    }) {
      const { worktree, hash, drop } = input;
      yield* onIndex(
        worktree,
        Effect.gen(function* () {
          const ref = yield* refOf(worktree, hash);
          yield* run(worktree, [
            "stash",
            "apply",
            "--end-of-options",
            ref,
          ]).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if ((yield* conflictedPaths(worktree)).length === 0) {
                  return yield* Effect.fail(error);
                }
                return yield* new GitRefusedError({
                  reason:
                    "The stash applied with conflicts. It's kept until they're resolved.",
                });
              }),
            ),
          );
          if (drop) yield* run(worktree, ["stash", "drop", "--quiet", ref]);
        }),
      );
    });

    const dropStash = Effect.fn("Git.dropStash")(function* (
      worktree: string,
      hash: string,
    ) {
      const ref = yield* refOf(worktree, hash);
      yield* run(worktree, ["stash", "drop", "--quiet", ref]);
    });

    // The way back from a drop: the stash's commit is still in the
    // object store, and `stash store` lists it again, on top, under its
    // subject as git words it. An unnamed one's names the stash itself
    // where git's names the commit under it, which nothing here reads.
    // store takes no --end-of-options, and needs none: the hash is
    // schema-pinned hex.
    const restoreStash = Effect.fn("Git.restoreStash")(function* (input: {
      readonly worktree: string;
      readonly branch: string;
      readonly hash: string;
      readonly message: string;
      readonly named: boolean;
    }) {
      const { worktree, branch, hash, message, named } = input;
      yield* run(worktree, [
        "stash",
        "store",
        "-m",
        named
          ? `On ${branch}: ${message}`
          : `WIP on ${branch}: ${hash} ${message}`,
        hash,
      ]);
    });

    // What a stash holds, as one patch: its tracked changes and the
    // untracked files it took, as additions.
    const readStashDiff = Effect.fn("Git.readStashDiff")(function* (
      worktree: string,
      hash: string,
    ) {
      const ref = yield* refOf(worktree, hash);
      return yield* run(
        worktree,
        [
          "-c",
          "core.quotePath=false",
          ...PATCH_CONFIG,
          "stash",
          "show",
          "-p",
          "--include-untracked",
          "--no-color",
          "--full-index",
          ...PATCH_FLAGS,
          ref,
        ],
        { maxOutputBytes: PATCH_MAX_OUTPUT },
      );
    });

    return {
      listStashes,
      stashChanges,
      applyStash,
      dropStash,
      restoreStash,
      readStashDiff,
    };
  });
