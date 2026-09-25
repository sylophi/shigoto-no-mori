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
import { type ClientConfig, ClientConfigSchema } from "@shared/schemas";
import {
  dropLegacyAppearance,
  readLegacyAppearance,
} from "@host/lib/config/global";
import { stateStore } from "@host/lib/config/store";
import {
  clientConfigPath,
  readClientConfigSync,
  writeClientConfig,
} from "./clientConfig";

export async function seedClientConfigFromLegacy(): Promise<void> {
  if (existsSync(clientConfigPath())) return;
  let seeded: ClientConfig;
  try {
    seeded = readLegacyAppearance();
  } catch (error) {
    // An unreadable config.json must never block boot. The store stays
    // absent, so the migration retries next boot.
    console.warn("[clientConfig] legacy appearance read failed:", error);
    return;
  }
  try {
    // writeClientConfig also primes the store memo, so the boot-time
    // theme read that follows sees the seeded values without a reread.
    await writeClientConfig(seeded);
  } catch (error) {
    // The store is still absent and config.json untouched, so seeding
    // retries next boot with nothing lost.
    console.warn("[clientConfig] seeding the appearance store failed:", error);
    return;
  }
  try {
    dropLegacyAppearance();
  } catch (error) {
    // The values are in the store. A leftover key in config.json is
    // harmless and drains on a later boot.
    console.warn("[clientConfig] legacy appearance drain failed:", error);
  }
}

// The sidebar's sort and fold, from when they lived in the host's
// state.json. They are the window's now (projectsSort and
// collapsedProjects in the client config). The sort moves over as it
// is. The fold does not: it was kept by local project id and is now
// kept by group key, the repo identity for most projects, which takes a
// git probe per project to learn, too much for a boot, so the folds
// reset once. Both old keys are drained after, which is what makes this
// run once: a later boot finds nothing to move. Runs after
// seedClientConfigFromLegacy and only once the store exists, so a
// failed appearance seed is never mistaken for done by that seed's
// existence probe. Every failure leaves state.json as it was, and the
// move retries next boot.
const LEGACY_SORT_KEY = "projectsSort";
const LEGACY_FOLD_KEY = "projectsCollapsed";

export async function seedProjectsSortFromState(): Promise<void> {
  if (!existsSync(clientConfigPath())) return;
  let legacySort: unknown;
  let legacyFold: unknown;
  try {
    legacySort = stateStore.readKey<unknown>(LEGACY_SORT_KEY, undefined);
    legacyFold = stateStore.readKey<unknown>(LEGACY_FOLD_KEY, undefined);
  } catch (error) {
    console.warn("[clientConfig] legacy project sort read failed:", error);
    return;
  }
  if (legacySort === undefined && legacyFold === undefined) return;
  // An invalid value is drained all the same, like the appearance keys:
  // the default is the right replacement for a value no build could
  // read. The manual order is the default, stored as nothing, and a
  // sort the store already holds is newer than this one.
  const sort = ClientConfigSchema.shape.projectsSort.safeParse(legacySort);
  const current = readClientConfigSync();
  if (
    sort.success &&
    sort.data !== undefined &&
    sort.data !== "manual" &&
    current.projectsSort === undefined
  ) {
    try {
      await writeClientConfig({ ...current, projectsSort: sort.data });
    } catch (error) {
      console.warn("[clientConfig] seeding the project sort failed:", error);
      return;
    }
  }
  try {
    stateStore.dropKeys([LEGACY_SORT_KEY, LEGACY_FOLD_KEY]);
  } catch (error) {
    // The sort is in the store. The drain retries next boot, which
    // seeds again only if the store holds no sort by then.
    console.warn("[clientConfig] legacy project sort drain failed:", error);
  }
}
