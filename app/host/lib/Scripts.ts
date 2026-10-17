// The scripts this machine runs and what is under way in its worktrees
// (V3.md, decision 20): the PTY runs and the engine's lifecycle runs,
// the marks that refuse a run or a second mutation, the busy count a
// quit asks, and the reap of a worktree removed behind the app's back.
// The layer's close is the quit's stop of every run.
import type { WorktreeSettingUpError } from "@shigomori/contracts/errors";
import type { RunningScript } from "@shigomori/contracts/schemas";
import type { BusyOperations } from "@shared/busy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type {
  NotifyScriptEvent,
  RunArgs,
  RunningScriptWorktree,
  ScriptRefusedError,
  WorktreeBusyError,
} from "./scripts/documents";
import { makeMarks } from "./scripts/marks";
import { makeRemoving } from "./scripts/removing";
import { type LifecycleRuns, makeRuns } from "./scripts/runs";
import type { PtySpawnError } from "./scripts/ScriptRuns";
import { makeUnderWay } from "./scripts/underWay";

export type {
  NotifyScriptEvent,
  RunningScriptWorktree,
  ScriptEnvValues,
} from "./scripts/documents";
export type { LifecycleRuns } from "./scripts/runs";

export class Scripts extends Context.Service<
  Scripts,
  {
    // A PTY run of the command in the worktree, answering its id.
    readonly start: (
      args: RunArgs,
    ) => Effect.Effect<string, ScriptRefusedError | PtySpawnError>;
    // The console's keystrokes and viewport size, for a PTY run.
    readonly write: (runId: string, data: string) => void;
    readonly resize: (runId: string, cols: number, rows: number) => void;
    // The console's Stop, of either kind of run: false when it is not
    // running here.
    readonly cancel: (runId: string) => Effect.Effect<boolean>;
    // Joins a run from a window that did not start it: every event from
    // now on goes to `notify` too, until the run ends or the caller's
    // connection goes. Answers the output so far, or null for a run not
    // running here.
    readonly attach: (
      runId: string,
      notify: NotifyScriptEvent,
    ) => { readonly output: string; readonly streaming: boolean } | null;
    // Every run, PTY and lifecycle alike, oldest first.
    readonly list: () => ReadonlyArray<RunningScript>;
    // The worktrees with a live PTY run.
    readonly worktrees: () => ReadonlyArray<RunningScriptWorktree>;
    // How many PTY runs are live in the worktree.
    readonly runningIn: (worktreeId: string) => number;
    // Books the lifecycle scripts one engine run reports, so the console
    // shows them and its Stop reaches them.
    readonly lifecycleRuns: (
      notify: NotifyScriptEvent,
    ) => Effect.Effect<LifecycleRuns>;
    readonly stopWorktree: (worktreeId: string) => Effect.Effect<void>;
    readonly stopProject: (projectId: string) => Effect.Effect<void>;
    readonly stopAll: (options?: {
      readonly graceMs?: number;
    }) => Effect.Effect<void>;
    // The create run that is still working in the worktree's checkout,
    // from the engine's "created" to its last phase.
    readonly markCreate: (worktreeId: string) => void;
    readonly clearCreate: (worktreeId: string) => void;
    readonly assertWorktreeMutable: (
      worktreeId: string,
      busyMessage: string,
    ) => Effect.Effect<void, WorktreeBusyError | WorktreeSettingUpError>;
    // The tombstone protocol (./scripts/removing.ts) around a mutation
    // that removes or moves worktrees.
    readonly withDeleteInflight: <A, E, R, E2, R2>(
      worktreeId: string,
      busyMessage: string,
      run: Effect.Effect<A, E, R>,
      mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
    ) => Effect.Effect<
      A,
      E | E2 | WorktreeBusyError | WorktreeSettingUpError,
      R | R2
    >;
    readonly withDeletesInflight: <A, E, R, E2, R2>(
      worktreeIds: readonly string[],
      busyMessage: string,
      run: Effect.Effect<A, E, R>,
      mirrorsAfter: (result: A) => Effect.Effect<unknown, E2, R2>,
    ) => Effect.Effect<
      A,
      E | E2 | WorktreeBusyError | WorktreeSettingUpError,
      R | R2
    >;
    // The worktrees a removal that stops their scripts itself (a nuke,
    // a data-folder move) works on, marked until the scope closes.
    readonly deleting: (
      worktreeIds: readonly string[],
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly removingProject: <A, E, R>(
      projectId: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly busy: Effect.Effect<BusyOperations>;
    readonly refuseNew: Effect.Effect<void>;
    readonly reapRemoved: Effect.Effect<ReadonlyArray<RunningScriptWorktree>>;
  }
>()("sm/host/Scripts") {}

type Options = {
  // Whether the quit is an update install or a relaunch.
  readonly hurried: () => boolean;
  // The environment a run inherits, as it is when it starts.
  readonly env: () => NodeJS.ProcessEnv;
};

const make = (options: Options) =>
  Effect.gen(function* () {
    const marks = yield* makeMarks;
    const runs = yield* makeRuns({ marks, env: options.env });
    const removing = yield* makeRemoving({ marks, runs });
    const { busy, quit } = yield* makeUnderWay({ marks, runs });
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => quit(options.hurried())).pipe(
        Effect.withSpan("Lifetime.stop", {
          attributes: { subsystem: "the scripts" },
        }),
      ),
    );
    return Scripts.of({
      ...runs,
      assertWorktreeMutable: marks.assertMutable,
      markCreate: marks.markCreate,
      clearCreate: marks.clearCreate,
      deleting: marks.deleting,
      removingProject: marks.removingProject,
      refuseNew: marks.refuseNew,
      ...removing,
      busy,
    });
  });

export const layer = (options: Options) => Layer.effect(Scripts, make(options));
