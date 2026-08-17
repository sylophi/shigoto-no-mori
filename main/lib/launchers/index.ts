// App detection + launching. The catalog and launch mechanics live in
// darwin.ts; this module adds the detection cache, custom launchers, and
// protocol deep links.
import { spawn } from "node:child_process";
import { ttlValueCache } from "../util/ttlCache";
import { detect, launch } from "./darwin";
import type { DetectedApp } from "./types";

export type { DetectedApp } from "./types";

// Detection is expensive (a dozen `which` shell-outs plus filesystem
// checks). Cache briefly so a single user action that needs the list a
// few times doesn't re-shell each time. Refreshes when the user opens
// the launcher row again after the TTL.
const DETECT_TTL_MS = 5_000;

const detectionCache = ttlValueCache<DetectedApp[]>(DETECT_TTL_MS, () =>
  detect(),
);

export function detectApps(): Promise<DetectedApp[]> {
  return detectionCache.get();
}

export function findDetected(
  id: string,
  all: DetectedApp[],
): DetectedApp | undefined {
  return all.find((a) => a.id === id);
}

export function launchDetected(
  app: DetectedApp,
  worktreePath: string,
): Promise<void> {
  return launch(app, worktreePath);
}

// Deep-link URL for launchers whose app opens via a custom protocol
// rather than a bundle invocation. These deliberately bypass the
// detected app even when one exists: the protocol URL is the only API
// these apps expose for "open this folder" -- launching the app with a
// path argument just opens the app. Detection still gates visibility
// (the launcher only shows when the app is installed, and installers
// register their scheme). The IPC layer opens the URL with Electron's
// shell.openExternal.
export function deepLinkFor(
  appId: string,
  worktreePath: string,
): string | null {
  if (appId === "codex") {
    const url = new URL("codex://threads/new");
    url.searchParams.set("path", worktreePath);
    return url.toString();
  }
  if (appId === "claude") {
    const url = new URL("claude://code/new");
    url.searchParams.set("folder", worktreePath);
    return url.toString();
  }
  return null;
}

export function launchCustom(command: string, worktreePath: string): void {
  const env = {
    ...process.env,
    SHIGOMORI_WORKSPACE_PATH: worktreePath,
  };
  // Detached + unref so the spawned process outlives this main process,
  // which matches "fire and forget launcher" semantics. `shell: true`
  // runs the user's command through /bin/sh.
  const child = spawn(command, [], {
    cwd: worktreePath,
    env,
    shell: true,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
