// The Electron half of the Safe Storage reset (main/core/keychain/reset.ts
// explains why it exists): names the item from app.name, keeps the
// marker in userData, and deletes through `security`. Called from
// main/index.ts for signed packaged builds on macOS, before anything
// can reach safeStorage.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { errorMessageOf } from "@shared/errors";
import {
  type ResetOutcome,
  resetSafeStorageOnce,
  SAFE_STORAGE_OWNED_MARKER,
  safeStorageItemNames,
} from "../core/keychain/reset";
import { deleteGenericPassword } from "../core/keychain/security";

export function resetSafeStorageItemOnce(): void {
  const userData = app.getPath("userData");
  const marker = join(userData, SAFE_STORAGE_OWNED_MARKER);
  const { service, account } = safeStorageItemNames(app.name);
  let outcome: ResetOutcome;
  try {
    outcome = resetSafeStorageOnce({
      hasMarker: () => existsSync(marker),
      writeMarker: () => {
        // First launch: userData may not exist yet.
        mkdirSync(userData, { recursive: true });
        writeFileSync(marker, "");
      },
      deleteItem: () => deleteGenericPassword(service, account),
    });
  } catch (error) {
    console.warn(
      `[keychain] could not reset the "${service}" item, will retry at ` +
        `the next launch: ${errorMessageOf(error)}`,
    );
    return;
  }
  if (outcome === "owned") return;
  console.log(
    outcome === "deleted"
      ? `[keychain] replaced the "${service}" item so this signed build ` +
          "owns it. Any earlier sign-in needs redoing once."
      : `[keychain] no "${service}" item to reset; this build creates it.`,
  );
}
