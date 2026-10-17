// What the host does across a project's checkouts: the reads cached
// where they are slow to repeat (carry-over's and the folder pickers'
// listings, worktrees/carryOver.ts), and the moves and removals that
// hold host state around the engine's commit: the running work they
// refuse, the tombstone, the removal announcements and the mirrors
// (V3.md, decision 20; worktrees/moving.ts, worktrees/removing.ts).
import type {
  UnknownProjectError,
  UnknownWorktreeError,
  WorktreeSettingUpError,
} from "@shigomori/contracts/errors";
import type {
  CarryOverCandidate,
  CarryOverStat,
  DeleteStackResult,
  DeleteWorktreeResult,
  Worktree,
} from "@shigomori/contracts/schemas";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Git from "@shigomori/engine/Git";
import { PeerReach } from "@host/ipc/PeerReach";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import type * as Engine from "./Engine";
import * as HostPushes from "./HostPushes";
import * as Scripts from "./Scripts";
import type { WorktreeBusyError } from "./scripts/documents";
import {
  type CarryOverCheckout,
  type FolderReadError,
  makeCarryOver,
} from "./worktrees/carryOver";
import type {
  RunningWorkError,
  ScriptsRunningError,
} from "./worktrees/documents";
import { makeMoving } from "./worktrees/moving";
import { makeRemoving, type RemoveInput } from "./worktrees/removing";

// What a move or a removal can fail with before or at the engine's
// commit.
type ChangeError =
  | UnknownProjectError
  | UnknownWorktreeError
  | Engine.EngineCallError
  | WorktreeBusyError
  | WorktreeSettingUpError;

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
    // The moves and removals name the worktree by its id or one it had
    // before a move. They run on the caller's engine, which a proof's
    // sandbox stands in for.
    //
    // `sm worktrees move`: the checkout to `destinationPath`, under the
    // id that path gives it.
    readonly relocate: (input: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly destinationPath: string;
    }) => Effect.Effect<
      Worktree,
      ChangeError | RunningWorkError,
      Engine.Services
    >;
    // A move to the same parent under a new folder name.
    readonly rename: (input: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly name: string;
    }) => Effect.Effect<
      Worktree,
      ChangeError | RunningWorkError,
      Engine.Services
    >;
    // A delete, its scripts stopped first, unless `refuseRunningScripts`.
    readonly remove: (
      input: RemoveInput & {
        readonly refuseRunningScripts?: boolean | undefined;
      },
      notifyScript: Scripts.NotifyScriptEvent,
    ) => Effect.Effect<
      DeleteWorktreeResult,
      ChangeError | ScriptsRunningError,
      Engine.Services
    >;
    // The worktrees of the landed layers of the stack the worktree is
    // the highest of, itself included, removed as one.
    readonly removeStack: (
      input: RemoveInput,
      notifyScript: Scripts.NotifyScriptEvent,
    ) => Effect.Effect<DeleteStackResult, ChangeError, Engine.Services>;
  }
>()("sm/host/Worktrees") {}

const make = Effect.gen(function* () {
  const host = Context.pick(
    HostPushes.HostPushes,
    MirrorEngine,
    PeerReach,
    Scripts.Scripts,
  )(
    yield* Effect.context<
      HostPushes.HostPushes | MirrorEngine | PeerReach | Scripts.Scripts
    >(),
  );
  return Worktrees.of({
    ...(yield* makeCarryOver),
    ...(yield* makeMoving(host)),
    ...(yield* makeRemoving(host)),
  });
});

export const layer = Layer.effect(Worktrees, make);
