// Resolves and spawns the bundled file-sync engine (file-sync/, built
// by scripts/build-file-sync.mjs) for the host's spawn seam
// (host/fileSync/spawn.ts). Addressed directly like the CLI binary:
// Resources/ when packaged, dist-file-sync/ in dev. Children register
// with the CLI runner's reap so quitting the app never leaves a daemon
// or a serve process behind.
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "@shared/fileSyncDist.mts";
import { setFileSyncSpawnImpl, spawnStreamChild } from "@host/fileSync/spawn";
import { bundledBinaryResolver } from "./bundledBinary";
import { registerBackgroundChild } from "./cliRunner";

export const fileSyncBinaryPath = bundledBinaryResolver(
  FILE_SYNC_DIST_DIR,
  FILE_SYNC_BINARY_NAME,
);

export function installFileSyncSpawner(): void {
  setFileSyncSpawnImpl((args) => {
    const binary = fileSyncBinaryPath();
    if (binary === null) return null;
    return spawnStreamChild(binary, args, {
      onSpawned: registerBackgroundChild,
    });
  });
}
