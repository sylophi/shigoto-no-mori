// Durable proof that the device's settings reach what follows them
// wherever they are written (host/process/wires.ts followDeviceSettings):
// a write through the engine's Config, as `sm config edit` makes it in
// a terminal, reconciles the direct listener. Only the Settings form's
// write did before, and directConnections isn't on the form.
//
// Run: pnpm test device-settings.
import assert from "node:assert/strict";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "vitest";
import { followDeviceSettings } from "@host/process/wires";
import { waitFor } from "./lib/checkKit.mts";
import { runHost } from "./lib/hostRuntime.mts";

it("a device setting written from the terminal reconciles the listener", async () => {
  let reconciled = 0;
  await runHost(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          followDeviceSettings(
            Effect.sync(() => {
              reconciled += 1;
            }),
          ),
        );
        const config = yield* EngineConfig.Config;
        // As `sm config edit` saves it.
        yield* config.change({ kind: "device" }, (doc) => ({
          ...doc,
          directConnections: false,
        }));
        yield* Effect.promise(() =>
          waitFor(() => reconciled > 0, "the listener reconciled"),
        );
      }),
    ),
  );
  assert.ok(reconciled > 0);
});
