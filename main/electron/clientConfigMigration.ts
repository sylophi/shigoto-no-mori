// Seed for installs whose appearance still lives in the shigomori
// root's config.json, from before the client/host split. Called from
// main/index.ts before the first window so the boot-time theme read
// already sees the migrated values. Self-consuming like the other
// in-repo migrations (ensureRegistrySplit, the state split): the drain
// deletes the legacy keys from config.json, and the store file it
// writes (an empty {} when nothing was found) is the retirement
// marker, so no later boot re-parses the legacy file. Re-entry is a
// no-op by construction: once the store exists this returns
// immediately, and the drained source has nothing left to resurrect.
// Only an absent store seeds: a corrupt one reads as defaults instead
// (see clientConfig.ts) and must not be silently reseeded over.
import { existsSync } from "node:fs";
import type { ClientConfig } from "@shared/schemas";
import { takeLegacyAppearance } from "@host/lib/config/global";
import { clientConfigPath, writeClientConfig } from "./clientConfig";

export async function seedClientConfigFromLegacy(): Promise<void> {
  if (existsSync(clientConfigPath())) return;
  let seeded: ClientConfig;
  try {
    seeded = takeLegacyAppearance();
  } catch (error) {
    // An unreadable config.json must never block boot. The store stays
    // absent, so the drain retries next boot.
    console.warn("[clientConfig] legacy appearance drain failed:", error);
    return;
  }
  try {
    // writeClientConfig also primes the store memo, so the boot-time
    // theme read that follows sees the seeded values without a reread.
    await writeClientConfig(seeded);
  } catch (error) {
    // The store is still absent, so seeding retries next boot.
    console.warn("[clientConfig] seeding the appearance store failed:", error);
  }
}
