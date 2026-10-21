// What the host does across a project's checkouts: the reads cached
// where they are slow to repeat (carry-over's and the folder pickers'
// listings, worktrees/carryOver.ts), and the creates, moves and removals
// that hold host state around the engine's commit: the create mark and
// the lifecycle scripts booked, the running work they refuse, the
// tombstone, the removal announcements and the mirrors
// (worktrees/creating.ts, moving.ts, removing.ts).
import type {
  UnknownProjectError,
  UnknownWorktreeError,
  WorktreeSettingUpError,
} from "@shigomori/contracts/errors";
import type {
  CarryOverCandidate,
  CarryOverStat,
  CreateWorktreeResult,
  DeleteStackResult,
  DeleteWorktreeResult,
  MovedSource,
  Worktree,
} from "@shigomori/contracts/schemas";
import type { SyncWorktreeFolderEntry } from "@shigomori/contracts/modules/sync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
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
import {
  type CreateFailure,
  type CreateInput,
  type CreateNotifiers,
  makeCreating,
} from "./worktrees/creating";
import { makeMoving } from "./worktrees/moving";
import { makeRemoving, type RemoveInput } from "./worktrees/removing";

export type { CreateNotifiers } from "./worktrees/creating";

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
    // The creates, moves and removals run on the caller's engine, which
    // a proof's sandbox stands in for.
    //
    // A new worktree, answered once the engine made it (or once its run
    // ended, `resolveOn` "exit") while its carry-over and setup go on.
    readonly create: (
      input: CreateInput,
      notify: CreateNotifiers,
      options?: { readonly resolveOn?: "created" | "exit" },
    ) => Effect.Effect<CreateWorktreeResult, CreateFailure, Engine.Services>;
    // An external checkout replaced by a managed one on its branch.
    readonly adopt: (
      input: {
        readonly projectId: string;
        readonly worktreeId: string;
        readonly force: boolean;
      },
      notify: CreateNotifiers,
    ) => Effect.Effect<CreateWorktreeResult, CreateFailure, Engine.Services>;
    // A landing's create, undone with the scope it is made in unless
    // `keep` committed it (worktrees/creating.ts says when).
    readonly createHeld: (
      input: CreateInput & { readonly branchName: string },
      notify: CreateNotifiers,
    ) => Effect.Effect<
      { readonly worktree: Worktree; readonly keep: Effect.Effect<void> },
      CreateFailure,
      Engine.Services | Scope.Scope
    >;
    // The moves and removals name the worktree by its id or one it had
    // before a move.
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
    // With `expect`, a transplant's teardown: refused unless the source
    // is still what moved, checked right before the delete.
    readonly remove: (
      input: RemoveInput & {
        readonly refuseRunningScripts?: boolean | undefined;
        readonly expect?: MovedSource | undefined;
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
    // A removal that must happen (a nuke's, a landing's undone create),
    // its cleanup on a clock of `cleanupWithin` ms (a minute by default),
    // and without it when it fails.
    readonly forceRemove: (input: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly cleanupWithin?: number | undefined;
    }) => Effect.Effect<void, ChangeError, Engine.Services>;
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
  const removing = yield* makeRemoving(host);
  return Worktrees.of({
    ...(yield* makeCarryOver),
    ...(yield* makeCreating(removing)),
    ...(yield* makeMoving(host)),
    ...removing,
  });
});

export const layer = Layer.effect(Worktrees, make);
