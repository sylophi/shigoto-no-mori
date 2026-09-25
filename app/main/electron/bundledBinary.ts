// Where a binary the app ships lives: Resources/ when packaged, the
// build's dist directory under the app path in dev. The sm CLI, the
// file-sync engine and cloudflared all follow this one rule.
import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export function bundledBinaryPath(devDistDir: string, name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), devDistDir, name);
}

// The same, existence-checked: a positive answer is cached (the binary
// doesn't move) and a miss re-probes, so a dev binary built after app
// launch is picked up.
export function bundledBinaryResolver(
  devDistDir: string,
  name: string,
): () => string | null {
  let cached: string | null = null;
  return () => {
    if (cached !== null) return cached;
    const candidate = bundledBinaryPath(devDistDir, name);
    if (!existsSync(candidate)) return null;
    cached = candidate;
    return candidate;
  };
}
