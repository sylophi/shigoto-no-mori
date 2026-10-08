// The engine (packages/engine) in the host: the same services the
// terminal `sm` runs on, over one store per process opened with
// node:sqlite. The terminal opens the same database file with Bun's
// driver, and SQLite serializes the two processes' writes.
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import type { Flavor } from "@shigomori/engine/flavor";
import { engineLayer } from "@shigomori/engine/layer";
import { codeOf, messageOf } from "@shigomori/engine/errorDocument";
import * as Store from "@shigomori/engine/Store";
import * as Worktrees from "@shigomori/engine/Worktrees";
import {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { registerInflightContributor } from "./scripts";
import * as PromiseAdapter from "./util/promiseAdapter";

export const layer = (options: {
  readonly flavor: Flavor;
  // The darwin helper, Resources/macfs when packaged.
  readonly macfs: string;
}) =>
  engineLayer({
    ...options,
    store: Store.layer((filename) => SqliteClient.make({ filename })),
  });

export type Services = Layer.Success<ReturnType<typeof layer>>;

// The Promise face, for the host code that is not Effect yet.
export const {
  layer: adapter,
  run,
  runSyncOr,
} = PromiseAdapter.make<Services>("The engine");

type Ids = { readonly projectId?: string; readonly worktreeId?: string };

// An engine failure the way the host's callers branch on it: a project
// or worktree that is gone as the contract's error, which the renderer
// reads by tag, and anything else in the words `sm` prints for it.
export function engineFailure(error: unknown, ids: Ids = {}): Error {
  const code = codeOf(error);
  if (code === "unknown-project" && ids.projectId !== undefined) {
    return new UnknownProjectError({ projectId: ids.projectId });
  }
  if (code === "unknown-worktree" && ids.worktreeId !== undefined) {
    return new UnknownWorktreeError({ worktreeId: ids.worktreeId });
  }
  return new Error(messageOf(error));
}

// Runs an engine effect for a Promise caller, its failure translated.
export const call = <A, E>(
  effect: Effect.Effect<A, E, Services>,
  ids: Ids = {},
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> =>
  run(
    effect.pipe(Effect.mapError((error) => engineFailure(error, ids))),
    options,
  );

// The engine operations under way that change something (a create, a
// removal, a merge), which the busy and quit prompts count. Reads are
// left out: they finish in moments and a quit may cut them short.
let changing = 0;
registerInflightContributor(() => changing);

// `call` for an operation that changes something.
export const change = <A, E>(
  effect: Effect.Effect<A, E, Services>,
  ids: Ids = {},
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> => {
  changing += 1;
  return call(effect, ids, options).finally(() => {
    changing -= 1;
  });
};

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
