// The host's terminals as the host builds them, over a store in a data
// dir: one runtime is one run of the app. The terminals proof runs it in
// its own process, and in a child (terminalsHost.mts) it kills.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import type { TerminalOwner } from "@shigomori/contracts/schemas";
import type {
  UnknownProjectError,
  UnknownWorktreeError,
} from "@shigomori/contracts/errors";
import * as Migration from "@shigomori/engine/Migration";
import * as Paths from "@shigomori/engine/Paths";
import * as SavedTerminals from "@shigomori/engine/SavedTerminals";
import * as Store from "@shigomori/engine/Store";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Terminals from "../../host/lib/terminals/Terminals.ts";

type Options = {
  readonly home: string;
  readonly dataDir: string;
};

// The engine's store and the platform, under the proof's home and data
// dir.
const withStore =
  (options: Options) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(
      Layer.provideMerge(SavedTerminals.layer),
      Layer.provide(Store.layer((filename) => SqliteClient.make({ filename }))),
      Layer.provide(Migration.layer),
      Layer.provide(Paths.layer("prod")),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { HOME: options.home, SHIGOMORI_DATA_DIR: options.dataDir },
          }),
        ),
      ),
    );

// The saved terminals alone, to read the store a running host writes.
export const openSavedTerminals = (options: Options) =>
  ManagedRuntime.make(Layer.empty.pipe(withStore(options)));

export const launchTerminals = (
  options: Options & {
    readonly start: (
      owner: TerminalOwner,
    ) => Effect.Effect<
      Terminals.Start,
      UnknownProjectError | UnknownWorktreeError
    >;
  },
) =>
  ManagedRuntime.make(
    Terminals.layer({ start: options.start }).pipe(withStore(options)),
  );
