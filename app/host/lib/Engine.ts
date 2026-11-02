// The engine (packages/engine) in the host: the same services the
// terminal `sm` runs on, over one store per process opened with
// node:sqlite. The terminal opens the same database file with Bun's
// driver, and SQLite serializes the two processes' writes.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as DataDirLock from "@shigomori/engine/DataDirLock";
import type { Flavor } from "@shigomori/engine/flavor";
import { migratingEngineLayer } from "@shigomori/engine/layer";
import { messageOf } from "@shigomori/engine/errorDocument";
import * as Git from "@shigomori/engine/Git";
import * as Store from "@shigomori/engine/Store";
import { storeErrorOf } from "@shigomori/engine/storeErrors";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  callFailureOf,
  isEntityGoneError,
  RemoteCallError,
  type UnknownProjectError,
  type UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import type { ChangeKind } from "@shigomori/contracts/modules/session";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { errorWordsOf } from "./errorWords";

// The scope an engine run outlives its caller in: a create the app
// navigates away from at "created" goes on to its setup here, and ends
// with the graph.
export class EngineRuns extends Context.Service<
  EngineRuns,
  { readonly scope: Scope.Scope }
>()("sm/host/EngineRuns") {}

type Ids = { readonly projectId?: string; readonly worktreeId?: string };

// The changes under way a quit asks about (`changing`): work a person
// started, or an auto-pull's fast-forward, each with what it is and the
// project and worktree it names (Scripts.busy).
export type UnderWay = { readonly ids: Ids; readonly kind: ChangeKind };

export class EngineChanges extends Context.Service<
  EngineChanges,
  {
    readonly underWay: () => ReadonlyArray<UnderWay>;
    // `effect` counted as a change of `kind` while it runs, or not at all
    // with none, unless it runs inside a counted change.
    readonly counted: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      ids: Ids,
      kind: ChangeKind | undefined,
    ) => Effect.Effect<A, E, R>;
  }
>()("sm/host/EngineChanges") {}

const open: Store.OpenDatabase = (filename, options) =>
  SqliteClient.make({ filename, ...options });

const runsLayer = Layer.effect(
  EngineRuns,
  Effect.map(Effect.scope, (scope) => EngineRuns.of({ scope })),
);

// The change a running effect is counted under: a change nested in it
// (a landing's create, the create's run forked to outlive its call)
// holds that one, which ends with the last of them, and names it when
// it was counted with no names (a call over the device link).
type Change = { ids: Ids; readonly kind: ChangeKind; holders: number };
const Counting = Context.Reference<Change | undefined>(
  "sm/host/EngineChanges/Counting",
  { defaultValue: () => undefined },
);

const changesLayer = Layer.sync(EngineChanges, () => {
  const changes = new Set<Change>();
  return EngineChanges.of({
    underWay: () => [...changes].map(({ ids, kind }) => ({ ids, kind })),
    counted: Effect.fn("EngineChanges.counted")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      ids: Ids,
      kind: ChangeKind | undefined,
    ) {
      const change =
        (yield* Counting) ??
        (kind === undefined ? undefined : { ids: {}, kind, holders: 0 });
      if (change === undefined) return yield* effect;
      if (change.ids.projectId === undefined) change.ids = { ...ids };
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          change.holders += 1;
          changes.add(change);
        }),
        () => Effect.provideService(effect, Counting, change),
        () =>
          Effect.sync(() => {
            change.holders -= 1;
            if (change.holders === 0) changes.delete(change);
          }),
      );
    }),
  });
});

export const layer = (options: {
  readonly flavor: Flavor;
  // The filesystem helper, Resources/nativefs when packaged.
  readonly nativefs: string;
  // The terminal `sm` the agent hooks run, Resources/sm when packaged.
  readonly sm: string;
}) =>
  migratingEngineLayer({
    ...options,
    store: Store.layer(open),
    open,
  }).pipe(
    // The environment as it is when the graph is built: after the
    // launch has rebuilt it from the login shell (shared/shellEnv.ts).
    // Effect's default reads it once, whenever first asked, which may
    // be before.
    Layer.provide(
      ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv())),
    ),
    // The scope a run outlives its caller in (EngineRuns, above), and
    // the changes under way.
    Layer.merge(runsLayer),
    Layer.merge(changesLayer),
  );

export type Services = Layer.Success<ReturnType<typeof layer>>;

// An engine failure in the words `sm` prints for it.
export class EngineCallError extends Schema.TaggedError<EngineCallError>()(
  "EngineCallError",
  { reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.reason;
  }
}

// An engine failure the way the host's callers branch on it: a project
// or worktree that is gone as the contract's error the engine fails
// with, which the renderer reads by tag, and anything else in the words
// `sm` prints for it.
export const engineFailure = (
  error: unknown,
): UnknownProjectError | UnknownWorktreeError | EngineCallError =>
  isEntityGoneError(error)
    ? error
    : new EngineCallError({ reason: messageOf(error), cause: error });

// An engine effect, its failure translated.
export const asCall = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(engineFailure));

// What a host call's failure crosses a wire as: a git the engine ran
// in the words errorWordsOf gives it, and anything else as
// callFailureOf makes it.
export const hostCallFailure = (error: unknown) => {
  const store = storeErrorOf(error);
  return callFailureOf(
    error instanceof Git.GitCommandError
      ? new RemoteCallError({ text: errorWordsOf(error) })
      : store !== undefined
        ? new RemoteCallError({ text: store.message })
        : error,
  );
};

// An operation that changes a worktree on disk, run only while no
// data-folder move can start (`DataDirLock`): every hold of the lock the
// host takes passes here. Its one home is where the work is asked for:
// a call that changes code is held by the link that serves it
// (socket/DeviceLink.ts), and what the host runs past such a call or
// apart from one (a create's whole run, a removal, a move, a landing, a
// capture, an auto-pull) is held by the service that runs it. A write
// that only touches the store holds nothing (DataDirLock.ts). Counted
// while it runs (Scripts.busy) when it is work a quit should wait on,
// which `kind` names: something a person started, or an auto-pull's
// fast-forward. `ids` name the worktree or project it changes, so a
// change of one being removed or moved counts as that removal or move.
export const changing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ids: Ids,
  kind?: ChangeKind,
) =>
  Effect.flatMap(EngineChanges, (changes) =>
    changes.counted(
      Effect.flatMap(DataDirLock.DataDirLock, (lock) => lock.guard(effect)),
      ids,
      kind,
    ),
  );

// `changing` around an engine verb, its failure translated.
export const asChange = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ids: Ids = {},
  kind?: ChangeKind,
) => asCall(changing(effect, ids, kind));

// A registered project by id.
export const projectById = (projectId: string) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* worktrees.resolveProjectById(
      yield* worktrees.nowhere,
      projectId,
    );
  });

// A worktree by its project's id and its own.
export const locate = (projectId: string, worktreeId: string) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* worktrees.resolve(yield* worktrees.nowhere, {
      projectId,
      worktreeId,
    });
  });
