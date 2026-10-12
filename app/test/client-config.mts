// Proof for the client config every window of an app instance follows
// (main/electron/clientConfig.ts, served as clientConfig:watch and
// clientConfig:patch), and for what a Settings save writes
// (renderer/hooks/config/useSettingsSave.ts, settingsWrites):
//   - two windows' patches, each made off a copy that never saw the
//     other's, keep both keys, and a cleared key goes,
//   - the watch says the config, then each patch, so every window sees
//     a change at once,
//   - a key a newer build wrote, which this build does not model, stays
//     on disk,
//   - a Save writes only the keys the form changed from what it last
//     saved: a form seeded from defaults because its read failed writes
//     the one key changed, not every default over what is stored.
//
// Run: pnpm test client-config.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import { fromConfig } from "@shigomori/ui/lib/settingsForm.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { afterAll, it, vi } from "vitest";
import { waitFor } from "./lib/checkKit.mts";

const dir = mkdtempSync(join(tmpdir(), "client-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
vi.mock("electron", () => ({
  app: { getPath: () => dir },
  nativeTheme: {},
}));
const { layer, clientConfigChanges, patchClientConfig } =
  await import("../main/electron/clientConfig");
const { settingsWrites } =
  await import("../renderer/hooks/config/useSettingsSave");

const stored = () =>
  JSON.parse(readFileSync(join(dir, "clientConfig.json"), "utf8")) as Record<
    string,
    unknown
  >;

it("two windows' patches keep each other's keys, the watch says each, and an unmodeled key stays", async () => {
  writeFileSync(
    join(dir, "clientConfig.json"),
    JSON.stringify({ theme: "light", fromANewerBuild: 1 }),
  );
  await Effect.runPromise(
    Layer.build(layer.pipe(Layer.provide(NodeServices.layer))).pipe(
      Effect.scoped,
    ),
  );
  const seen: ClientConfig[] = [];
  const watching = Effect.runFork(
    Stream.runForEach(clientConfigChanges, (config) =>
      Effect.sync(() => {
        seen.push(config);
      }),
    ),
  );
  await waitFor(() => seen.length === 1, "the watch's first value");
  assert.deepEqual(seen[0], { theme: "light", fromANewerBuild: 1 });

  // Window A picks dark while window B, which last saw the config
  // before it, turns Village life on: both land.
  await Promise.all([
    patchClientConfig({ theme: "dark" }, []),
    patchClientConfig({ villageLife: true }, []),
  ]);
  assert.equal(stored().theme, "dark");
  assert.equal(stored().villageLife, true);
  await waitFor(() => seen.length === 3, "a value per patch");
  assert.deepEqual(seen.at(-1), {
    theme: "dark",
    fromANewerBuild: 1,
    villageLife: true,
  });

  await patchClientConfig({}, ["theme"]);
  await waitFor(() => seen.length === 4, "the clear");
  assert.equal(stored().theme, undefined, "a cleared key goes");
  assert.equal(stored().fromANewerBuild, 1, "an unmodeled key stays");
  await Effect.runPromise(Fiber.interrupt(watching));
});

it("a Save writes only what the form changed: a form seeded from defaults writes the one key", () => {
  // The read failed, so the form stands on defaults while the stored
  // config has a theme, a palette and every device setting.
  const saved = fromConfig({}, {});
  const state = { ...saved, villageLife: true };
  const { devicePatch, clientPatch } = settingsWrites(saved, state);
  assert.deepEqual(devicePatch, {});
  assert.deepEqual(clientPatch, { villageLife: true });

  // A setting turned back to its default clears its key.
  const back = settingsWrites(
    { ...saved, theme: "dark" },
    { ...saved, theme: "system" },
  );
  assert.deepEqual(back.clientPatch, { theme: undefined });
  assert.ok("theme" in back.clientPatch);
});
