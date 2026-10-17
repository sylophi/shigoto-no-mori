// The engine (packages/engine) in the host: the same services the
// terminal `sm` runs on, over one store per process opened with
// node:sqlite. The terminal opens the same database file with Bun's
// driver, and SQLite serializes the two processes' writes.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as DataDirLock from "@shigomori/engine/DataDirLock";
import type { Flavor } from "@shigomori/engine/flavor";
import { migratingEngineLayer } from "@shigomori/engine/layer";
import { codeOf, messageOf } from "@shigomori/engine/errorDocument";
import * as Git from "@shigomori/engine/Git";
import * as Store from "@shigomori/engine/Store";
import { storeErrorOf } from "@shigomori/engine/storeErrors";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  callFailureOf,
  RemoteCallError,
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
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

// The engine changes under way (`changing`), each with the project and
// worktree it names, which the busy count reads (Scripts.busy).
export class EngineChanges extends Context.Service<
  EngineChanges,
  {
    readonly underWay: () => ReadonlyArray<Ids>;
    readonly counted: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      ids: Ids,
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
// it was counted with no names (a peer's call, DeviceLink).
type Change = { ids: Ids; holders: number };
const Counting = Context.Reference<Change | undefined>(
  "sm/host/EngineChanges/Counting",
  { defaultValue: () => undefined },
);

const changesLayer = Layer.sync(EngineChanges, () => {
  const changes = new Set<Change>();
  return EngineChanges.of({
    underWay: () => [...changes].map((change) => change.ids),
    counted: Effect.fn("EngineChanges.counted")(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      ids: Ids,
    ) {
      const change = (yield* Counting) ?? { ids: {}, holders: 0 };
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
  // The darwin helper, Resources/macfs when packaged.
  readonly macfs: string;
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
// or worktree that is gone as the contract's error, which the renderer
// reads by tag, and anything else in the words `sm` prints for it.
export function engineFailure(
  error: unknown,
  ids: Ids = {},
): UnknownProjectError | UnknownWorktreeError | EngineCallError {
  const code = codeOf(error);
  if (code === "unknown-project" && ids.projectId !== undefined) {
    return new UnknownProjectError({ projectId: ids.projectId });
  }
  if (code === "unknown-worktree" && ids.worktreeId !== undefined) {
    return new UnknownWorktreeError({ worktreeId: ids.worktreeId });
  }
  return new EngineCallError({ reason: messageOf(error), cause: error });
}

// An engine effect, its failure translated.
export const asCall = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ids: Ids = {},
) => effect.pipe(Effect.mapError((error) => engineFailure(error, ids)));

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

// An operation that changes something, counted while it runs
// (Scripts.busy), and run only while no data-folder move can start
// (`DataDirLock`): every hold of the lock the host takes passes here, so
// a quit sees each one.
export const changing = <A, E, R>(effect: Effect.Effect<A, E, R>, ids: Ids) =>
  Effect.flatMap(EngineChanges, (changes) =>
    changes.counted(
      Effect.flatMap(DataDirLock.DataDirLock, (lock) => lock.guard(effect)),
      ids,
    ),
  );

// `changing`, its failure translated: every change the host makes
// through the engine.
export const asChange = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ids: Ids = {},
) => asCall(changing(effect, ids), ids);

// The engine's view of where the host stands: nowhere, since a host
// call names its project and worktree by id.
const nowhere = Effect.gen(function* () {
  return yield* (yield* Worktrees.Worktrees).here("/");
});

// A registered project by id.
export const projectById = (projectId: string) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* worktrees.resolveProjectById(yield* nowhere, projectId);
  });

// A worktree by its project's id and its own.
export const locate = (projectId: string, worktreeId: string) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    return yield* worktrees.resolve(yield* nowhere, { projectId, worktreeId });
  });
