// What the terminal `sm`, an agent or the app itself writes to the
// store, in the host: the engine's StoreChanges, which the views re-read
// off (views.ts), and today's pushes for the renderer, which still
// invalidates its queries on them (step 6 of V3.md subscribes it to the
// views instead).
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import type { Table } from "@shigomori/engine/StoreChanges";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as PromiseAdapter from "./util/promiseAdapter";

// The tables behind the rows a project's pages show. The usage log and
// the shared settings have pushes of their own (projects:usageBumped,
// sharedSettings:changed), and the device-wide sweep a change here
// sets off would refetch every page over one of them.
const forest: readonly Table[] = [
  "projects",
  "project_order",
  "worktree_marks",
  "shelf_snapshots",
  "device",
  "device_config",
  "project_config",
  "worktree_data",
  "script_sort",
  "script_lists",
  "agent_sessions",
];

// `onChange` runs once a tick in which the store wrote any of the
// forest's tables.
export const layer = (onChange: () => void) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const changes = yield* (yield* StoreChanges.StoreChanges).subscribe;
      yield* changes.pipe(
        Stream.filter((tables) => forest.some((table) => tables.has(table))),
        Stream.runForEach(() => Effect.sync(onChange)),
        Effect.forkScoped,
      );
    }),
  );

// For the data-folder move, which is not Effect yet.
const promiseAdapter = PromiseAdapter.forService(
  StoreChanges.StoreChanges,
  "The store changes",
);
export const adapter = promiseAdapter.layer;

// Changes that are not up have nothing to release.
export function releaseStore(): Promise<void> {
  return promiseAdapter.runIfOpen(
    Effect.gen(function* () {
      yield* (yield* StoreChanges.StoreChanges).release;
    }),
  );
}
