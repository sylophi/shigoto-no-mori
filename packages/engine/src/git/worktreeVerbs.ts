// Git's worktree verbs: listing, adding, moving and removing linked worktrees.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { parseWorktreeList, splitLines, splitRemoteRef } from "../gitParse.ts";
import type { RunningArea } from "./running.ts";

export const makeWorktreeVerbs = ({
  running,
}: {
  readonly running: RunningArea;
}) =>
  Effect.sync(() => {
    const { run, succeeds } = running;
    const listWorktrees = Effect.fn("Git.listWorktrees")(function* (
      repo: string,
    ) {
      return parseWorktreeList(
        yield* run(repo, ["worktree", "list", "--porcelain", "-z"]),
      );
    });

    const addWorktree = Effect.fn("Git.addWorktree")(function* (input: {
      readonly repo: string;
      readonly path: string;
      readonly branch: string;
      readonly base?: string | undefined;
      readonly noCheckout?: boolean | undefined;
    }) {
      // A new branch is unpublished: off origin/main, git's default
      // (branch.autoSetupMerge) would track main, where a push of it
      // is refused or lands.
      yield* run(input.repo, [
        "worktree",
        "add",
        "--no-track",
        "-b",
        input.branch,
        ...(input.noCheckout ? ["--no-checkout"] : []),
        "--",
        input.path,
        ...(input.base ? [input.base] : []),
      ]);
    });

    const listRemotes = Effect.fn("Git.listRemotes")(function* (repo: string) {
      return yield* run(repo, ["remote"]).pipe(
        Effect.map(splitLines),
        Effect.orElseSucceed(() => []),
      );
    });

    const localBranchExists = Effect.fn("Git.localBranchExists")(function* (
      repo: string,
      branch: string,
    ) {
      return yield* succeeds(repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ]);
    });

    const remoteRefExists = Effect.fn("Git.remoteRefExists")(function* (
      repo: string,
      ref: string,
    ) {
      return yield* succeeds(repo, [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/${ref}`,
      ]);
    });

    const resolveCheckoutRef = Effect.fn("Git.resolveCheckoutRef")(function* (
      repo: string,
      ref: string,
      remotes?: readonly string[],
    ) {
      if (yield* localBranchExists(repo, ref)) {
        return { target: ref, track: Option.none<string>() };
      }
      const split = splitRemoteRef(ref, remotes ?? (yield* listRemotes(repo)));
      if (!split) return { target: ref, track: Option.none<string>() };
      if (yield* localBranchExists(repo, split.branch)) {
        return { target: split.branch, track: Option.none<string>() };
      }
      return { target: ref, track: Option.some(split.branch) };
    });

    const checkoutWorktree = Effect.fn("Git.checkoutWorktree")(
      function* (input: {
        readonly repo: string;
        readonly path: string;
        readonly ref: string;
        readonly remotes?: readonly string[] | undefined;
        readonly noCheckout?: boolean | undefined;
        // Checked out though another worktree has it, as an adopt's
        // replacement made before the checkout it replaces goes.
        readonly force?: boolean | undefined;
      }) {
        const { target, track } = yield* resolveCheckoutRef(
          input.repo,
          input.ref,
          input.remotes,
        );
        yield* run(input.repo, [
          "worktree",
          "add",
          ...(input.noCheckout ? ["--no-checkout"] : []),
          ...(input.force ? ["--force"] : []),
          ...Option.match(track, {
            onNone: () => [],
            onSome: (name) => ["--track", "-b", name],
          }),
          "--",
          input.path,
          target,
        ]);
      },
    );

    const removeWorktree = Effect.fn("Git.removeWorktree")(function* (input: {
      readonly repo: string;
      readonly path: string;
      readonly force: boolean;
    }) {
      yield* run(input.repo, [
        "-c",
        "status.showUntrackedFiles=normal",
        "worktree",
        "remove",
        input.path,
        ...(input.force ? ["--force"] : []),
      ]);
    });

    const pruneWorktrees = Effect.fn("Git.pruneWorktrees")(function* (
      repo: string,
    ) {
      yield* run(repo, ["worktree", "prune"]);
    });

    return {
      listWorktrees,
      addWorktree,
      listRemotes,
      localBranchExists,
      remoteRefExists,
      resolveCheckoutRef,
      checkoutWorktree,
      removeWorktree,
      pruneWorktrees,
    };
  });

export type WorktreeVerbsArea = Effect.Success<
  ReturnType<typeof makeWorktreeVerbs>
>;
