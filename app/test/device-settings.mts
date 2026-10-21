// Durable proof that the device's settings reach what follows them
// wherever they are written (host/process/wires.ts followDeviceSettings):
// the terminal `sm`'s write, on a connection of its own, reaches the
// follower the host's graph reconciles the direct listener with.
//
// Run: pnpm test device-settings.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { it } from "vitest";
import { followDeviceSettings } from "@host/process/wires";
import { createCliRunner, waitFor } from "./lib/checkKit.mts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";
import { builtSm } from "./lib/smBinary.mts";

it("a device setting the terminal writes reaches what follows the settings", async () => {
  const { sm } = createCliRunner(builtSm(), {
    ...process.env,
    SHIGOMORI_DATA_DIR: engineDataDir,
  });
  let followed = 0;
  await runHost(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          followDeviceSettings(
            Effect.sync(() => {
              followed += 1;
            }),
          ),
        );
        yield* Effect.promise(() =>
          sm("config", "set", "launchScripts", "false"),
        );
        yield* Effect.promise(() =>
          waitFor(() => followed > 0, "the settings followed"),
        );
      }),
    ),
  );
  assert.ok(followed > 0);
});
