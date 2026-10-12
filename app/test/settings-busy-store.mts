// Durable proof that the shared settings' writer
// (host/lib/sharedSettings/store.ts) outlives a write the store refused.
// The writer stores each change behind the copy, one at a time, and a
// failed write used to end it: every change after it was announced to
// the windows and peers and never stored. Asserts, with the store's
// write lock held elsewhere past the driver's wait, that the change
// refused then and the one made after it both land once the lock is
// let go, in order.
//
// Run: pnpm test settings-busy-store.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import {
  sharedSettingKeys,
  sharedStringSetting,
} from "@shigomori/contracts/sharedSettings";
import {
  sharedSettingsCopy,
  sharedSettingsLoaded,
  sharedSettingsStored,
} from "@host/lib/sharedSettings/store";
import * as SharedSettings from "@shigomori/engine/SharedSettings";
import { it } from "vitest";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";

const FIRST = sharedSettingKeys.quickCreateDevice("github.com/acme/first");
const SECOND = sharedSettingKeys.quickCreateDevice("github.com/acme/second");

it("a change the store refused is stored once it can be, and the next lands behind it", async () => {
  await runHost(sharedSettingsLoaded);
  const holder = new DatabaseSync(join(engineDataDir, "store.db"));
  holder.exec("BEGIN IMMEDIATE");
  try {
    sharedSettingsCopy.set(FIRST, "kiwi");
    // Past the driver's five seconds of waiting on the lock.
    await new Promise((resolve) => setTimeout(resolve, 7000));
    sharedSettingsCopy.set(SECOND, "lychee");
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  await Effect.runPromise(
    sharedSettingsStored.pipe(Effect.timeout("20 seconds")),
  );
  const stored = await runHost(
    Effect.flatMap(SharedSettings.SharedSettings, (settings) => settings.read),
  );
  assert.equal(sharedStringSetting(stored, FIRST), "kiwi");
  assert.equal(sharedStringSetting(stored, SECOND), "lychee");
});
