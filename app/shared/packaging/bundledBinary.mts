// Where a binary the app ships lives: Resources/ when packaged, the
// build's dist directory under the app path in dev. The sm CLI, the
// file-sync engine and cloudflared all follow this one rule. The shell
// and the host each know their app's place (main/electron/appPlace.ts,
// host/process/facts.ts) and pass it in.
import { existsSync } from "node:fs";
import path from "node:path";

export type AppPlace = {
  readonly packaged: boolean;
  // The app's own directory, where a dev build's dist folders are.
  readonly appPath: string;
  // Resources/ in a packaged build.
  readonly resourcesPath: string;
};

export function bundledBinaryPath(
  place: AppPlace,
  devDistDir: string,
  name: string,
): string {
  return place.packaged
    ? path.join(place.resourcesPath, name)
    : path.join(place.appPath, devDistDir, name);
}

// The same, existence-checked: a positive answer is cached (the binary
// doesn't move) and a miss re-probes, so a dev binary built after app
// launch is picked up.
export function bundledBinaryResolver(
  place: () => AppPlace,
  devDistDir: string,
  name: () => string,
): () => string | null {
  let cached: string | null = null;
  return () => {
    if (cached !== null) return cached;
    const candidate = bundledBinaryPath(place(), devDistDir, name());
    if (!existsSync(candidate)) return null;
    cached = candidate;
    return candidate;
  };
}
