// What the host reads across a project's checkouts, each answer cached
// where it is slow to repeat: carry-over's and the folder pickers'
// listings (worktrees/carryOver.ts), and the tidy page's facts and
// disk sizes (worktrees/hygiene.ts).
import type {
  CarryOverCandidate,
  CarryOverStat,
  WorktreeDiskUsage,
  WorktreeHygiene,
} from "@shigomori/contracts/schemas";
import type {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EngineCallError } from "./engine";
import type * as Git from "@shigomori/engine/Git";
import type { WorktreeIdentity } from "@shigomori/contracts/schemas";
import {
  type CarryOverCheckout,
  type FolderReadError,
  makeCarryOver,
} from "./worktrees/carryOver";
import { makeHygiene } from "./worktrees/hygiene";

type EngineError = UnknownProjectError | UnknownWorktreeError | EngineCallError;

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
    // How stale each of the project's worktrees is, and whether its
    // work already landed in the primary branch.
    readonly hygiene: (
      projectId: string,
      projectPath: string,
    ) => Effect.Effect<WorktreeHygiene[], EngineError | Git.GitError>;
    readonly worktreeForDisk: (
      projectId: string,
      worktreeId: string,
    ) => Effect.Effect<WorktreeIdentity, EngineError>;
    // A whole directory walk, so asked one row at a time.
    readonly diskUsage: (
      projectId: string,
      worktree: WorktreeIdentity,
    ) => Effect.Effect<WorktreeDiskUsage, EngineError>;
  }
>()("sm/host/Worktrees") {}

const make = Effect.gen(function* () {
  const carryOver = yield* makeCarryOver;
  const hygiene = yield* makeHygiene;
  return Worktrees.of({ ...carryOver, ...hygiene });
});

export const layer = Layer.effect(Worktrees, make);
