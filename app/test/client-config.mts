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
//   - the store turns an Each launch palette rotation once per run
//     however many windows ask at once, and a check with none due
//     writes nothing,
//   - a Save writes only the keys the form changed from what it last
//     saved: a form seeded from defaults because its read failed writes
//     the one key changed, not every default over what is stored,
//   - a peer's form whose device changed a key meanwhile keeps the
//     fields edited here over it and takes the rest, and its Save
//     writes only what was edited, so the device's own change stays,
//   - a Save whose device half landed and client half failed leaves
//     only the client fields unsaved.
//
// Run: pnpm test client-config.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import {
  fromConfig,
  keepTouched,
  withClientFields,
} from "@shigomori/ui/lib/settingsForm.ts";
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
const { layer, clientConfigChanges, patchClientConfig, rotatePalette } =
  await import("../main/electron/clientConfig");
const { peerSettingsWrite, settingsWrites } =
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

it("the store turns an Each launch rotation once per run, and a check with none due writes nothing", async () => {
  await patchClientConfig({ themeRotation: "launch" }, []);
  const stamps = await Promise.all([rotatePalette(true), rotatePalette(true)]);
  const made = stamps.filter((stamp) => stamp !== null);
  assert.equal(made.length, 1, "two windows' launch asks, one turn");
  assert.equal(stored().themeRotatedAt, made[0]);
  assert.equal(stored().lightTheme, "latte");
  // Unindented, as no write of the store's leaves it.
  const file = join(dir, "clientConfig.json");
  const untouched = JSON.stringify(stored());
  writeFileSync(file, untouched);
  assert.equal(await rotatePalette(true), null, "a window opened later");
  assert.equal(await rotatePalette(false), null, "a minute's check");
  assert.equal(readFileSync(file, "utf8"), untouched, "nothing written");
  assert.equal(stored().lightTheme, "latte");
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

it("a peer's form keeps its edits over the device's own change, and its Save writes only those", () => {
  const saved = fromConfig({}, {});
  const form = { ...saved, autoPullNew: true };
  // The device's own user turned terrier on while the form was open.
  const moved = fromConfig({ terrier: true }, {});
  const next = keepTouched(form, saved, moved);
  assert.equal(next.autoPullNew, true);
  assert.equal(next.terrier, true);
  assert.deepEqual(peerSettingsWrite(moved, next), { autoPullNew: true });
  assert.deepEqual(peerSettingsWrite(moved, moved), {});
});

it("a Save advances only the fields it carried, so a change made meanwhile stays", () => {
  const saved = fromConfig({}, {});
  const form = { ...saved, autoPullNew: true };
  // The device turned terrier on while the Save was out.
  const prev = fromConfig({ terrier: true }, {});
  const snapshot = keepTouched(form, saved, prev);
  assert.equal(snapshot.autoPullNew, true);
  assert.equal(snapshot.terrier, true);
  const merged = keepTouched(form, saved, prev);
  assert.deepEqual(peerSettingsWrite(snapshot, merged), {});
});

it("a Save whose client half failed leaves only the client fields unsaved", () => {
  const saved = fromConfig({}, {});
  const form = { ...saved, theme: "dark" as const, autoPullNew: true };
  const snapshot = withClientFields(form, saved);
  assert.equal(snapshot.autoPullNew, true);
  assert.equal(snapshot.theme, "system");
  const { devicePatch, clientPatch } = settingsWrites(snapshot, form);
  assert.deepEqual(devicePatch, {});
  assert.deepEqual(clientPatch, { theme: "dark" });
});
