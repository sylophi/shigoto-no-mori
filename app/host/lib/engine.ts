// The engine (packages/engine) in the host: the same services the
// terminal `sm` runs on, over one store per process opened with
// node:sqlite. The terminal opens the same database file with Bun's
// driver, and SQLite serializes the two processes' writes.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import type { Flavor } from "@shigomori/engine/flavor";
import { engineLayer } from "@shigomori/engine/layer";
import { codeOf, messageOf } from "@shigomori/engine/errorDocument";
import * as Migration from "@shigomori/engine/Migration";
import * as Store from "@shigomori/engine/Store";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { registerInflightContributor } from "./scripts";

// The scope an engine run outlives its caller in: a create the app
// navigates away from at "created" goes on to its setup here, and ends
// with the graph.
export class EngineRuns extends Context.Service<
  EngineRuns,
  { readonly scope: Scope.Scope }
>()("sm/host/EngineRuns") {}

const runsLayer = Layer.effect(
  EngineRuns,
  Effect.map(Effect.scope, (scope) => EngineRuns.of({ scope })),
);

export const layer = (options: {
  readonly flavor: Flavor;
  // The darwin helper, Resources/macfs when packaged.
  readonly macfs: string;
  // The terminal `sm` the agent hooks run, Resources/sm when packaged.
  readonly sm: string;
}) =>
  engineLayer({
    ...options,
    store: Store.layer((filename) => SqliteClient.make({ filename })),
  }).pipe(
    // The environment as it is when the graph is built: after the
    // launch has rebuilt it from the login shell (host/lib/util/shellEnv.ts).
    // Effect's default reads it once, whenever first asked, which may
    // be before.
    Layer.provide(
      ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv())),
    ),
    // The v3 migration the store and the move into `wt/` report to.
    Layer.provideMerge(Migration.layer),
    // The scope a run outlives its caller in (EngineRuns, below).
    Layer.merge(runsLayer),
  );

export type Services = Layer.Success<ReturnType<typeof layer>>;

// The engine as an effect found it, for the Promise code the effect
// hands it (the source link's protocol, the mirror's git follower):
// what that code asks of the engine runs on the effect's own engine.
export type Handle = Context.Context<Services>;
export const handle: Effect.Effect<Handle, never, Services> =
  Effect.context<Services>();
export const runWith =
  (engine: Handle) =>
  <A, E>(effect: Effect.Effect<A, E, Services>): Promise<A> =>
    Effect.runPromiseWith(engine)(effect);

type Ids = { readonly projectId?: string; readonly worktreeId?: string };

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

// `asCall` for an operation that changes something, counted while it
// runs.
export const asChange = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ids: Ids = {},
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      changing += 1;
    }),
    () => asCall(effect, ids),
    () =>
      Effect.sync(() => {
        changing -= 1;
      }),
  );

// The engine operations under way that change something (a create, a
// removal, a merge), which the busy and quit prompts count. Reads are
// left out: they finish in moments and a quit may cut them short.
let changing = 0;
registerInflightContributor(() => changing);

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
