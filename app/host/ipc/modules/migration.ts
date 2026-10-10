import { migrationContract } from "@shigomori/contracts/modules/migration";
import type { ViewHandlers } from "@shigomori/contracts/types";
import * as Migration from "@shigomori/engine/Migration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

// The engine's migration as it goes, for the page a window shows in
// place of the app while it runs.
export const migrationViews: ViewHandlers<
  typeof migrationContract,
  Migration.Migration
> = {
  watch: () =>
    Stream.unwrap(Effect.map(Migration.Migration, (it) => it.changes)),
};
