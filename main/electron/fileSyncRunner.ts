// Resolves and spawns the bundled file-sync engine (file-sync/, built
// by scripts/build-file-sync.mjs) for the host's spawn seam
// (host/fileSync/spawn.ts). Addressed directly like the CLI binary:
// Resources/ when packaged, dist-file-sync/ in dev. Children register
// with the CLI runner's reap so quitting the app never leaves a daemon
// or a serve process behind.
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "@shared/fileSyncDist.mts";
import { setFileSyncSpawnImpl, spawnStreamChild } from "@host/fileSync/spawn";
import { registerBackgroundChild } from "./cliRunner";

function candidateBinary(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, FILE_SYNC_BINARY_NAME)
    : path.join(app.getAppPath(), FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME);
}

// Positive result cached (the binary doesn't move); a miss re-probes so
// a dev binary built after app launch is picked up.
let cachedBinary: string | null = null;

export function fileSyncBinaryPath(): string | null {
  if (cachedBinary !== null) return cachedBinary;
  const candidate = candidateBinary();
  if (existsSync(candidate)) {
    cachedBinary = candidate;
    return candidate;
  }
  return null;
}

export function installFileSyncSpawner(): void {
  setFileSyncSpawnImpl((args) => {
    const binary = fileSyncBinaryPath();
    if (binary === null) return null;
    return spawnStreamChild(binary, args, {
      onSpawned: registerBackgroundChild,
    });
  });
}
