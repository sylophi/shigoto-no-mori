// What the host reads across a project's checkouts, each answer cached
// where it is slow to repeat: carry-over's and the folder pickers'
// listings (worktrees/carryOver.ts).
import type {
  CarryOverCandidate,
  CarryOverStat,
} from "@shigomori/contracts/schemas";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Git from "@shigomori/engine/Git";
import {
  type CarryOverCheckout,
  type FolderReadError,
  makeCarryOver,
} from "./worktrees/carryOver";

export class Worktrees extends Context.Service<
  Worktrees,
  {
    // Every checkout of the project, the primary first.
    readonly carryOverCheckouts: (
      projectId: string,
      projectPath: string,
    ) => Effect.Effect<CarryOverCheckout[]>;
    // The union of `relative` across the checkouts.
    readonly carryOverCandidates: (
      checkouts: readonly CarryOverCheckout[],
      relative: string,
      options?: { ruleIgnored?: boolean },
    ) => Effect.Effect<CarryOverCandidate[], FolderReadError>;
    readonly carryOverStats: (
      checkouts: readonly CarryOverCheckout[],
      paths: readonly string[],
    ) => Effect.Effect<Record<string, CarryOverStat>>;
    // One folder of one checkout, with git's ignore verdict per entry.
    readonly worktreeFolder: (
      worktreePath: string,
      relative: string,
      ruleIgnored: boolean,
    ) => Effect.Effect<
      SyncWorktreeFolderEntry[],
      FolderReadError | Git.GitError
    >;
    // The untracked paths git ignores in a checkout.
    readonly ignoredPaths: (
      worktreePath: string,
    ) => Effect.Effect<string[], Git.GitError>;
  }
>()("sm/host/Worktrees") {}

const make = Effect.gen(function* () {
  return Worktrees.of(yield* makeCarryOver);
});

export const layer = Layer.effect(Worktrees, make);
