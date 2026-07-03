// App detection + launching, platform-selected once here. Each platform
// owns its own catalog and launch mechanics (darwin.ts / win32.ts); this
// module adds the pieces that are genuinely shared -- the detection
// cache, custom launchers, and protocol deep links -- so callers never
// branch on platform themselves.
import { spawn } from "node:child_process";
import { isWindows } from "../util/platform";
import { ttlValueCache } from "../util/ttlCache";
import { darwinLaunchers } from "./darwin";
import type { DetectedApp, PlatformLaunchers } from "./types";
import { win32Launchers } from "./win32";

export type { DetectedApp } from "./types";

const impl: PlatformLaunchers = isWindows ? win32Launchers : darwinLaunchers;

// Detection is expensive (a dozen `which`/`where` shell-outs plus
// filesystem checks). Cache briefly so a single user action that needs
// the list a few times doesn't re-shell each time. Refreshes when the
// user opens the launcher row again after the TTL.
const DETECT_TTL_MS = 5_000;

const detectionCache = ttlValueCache<DetectedApp[]>(DETECT_TTL_MS, () =>
  impl.detect(),
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
  return impl.launch(app, worktreePath);
}

// Deep-link URL for launchers whose app opens via a custom protocol
// rather than an exe/bundle invocation. These deliberately bypass the
// detected exe even when one exists: the protocol URL is the only API
// these apps expose for "open this folder" -- spawning the exe with a
// path argument just opens the app. Detection still gates visibility
// (the launcher only shows when the app is installed, and installers
// register their scheme). The IPC layer opens the URL with Electron's
// shell.openExternal -- routing it through a shell would expose it to
// cmd.exe's %VAR% expansion on Windows. Ids a platform's catalog
// doesn't include (codex is macOS-only) are simply never asked for.
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
  // runs the user's command through /bin/sh on POSIX and cmd.exe on
  // Windows, so commands are authored in the platform's native syntax.
  const child = spawn(command, [], {
    cwd: worktreePath,
    env,
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
