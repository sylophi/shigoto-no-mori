// In-app auto-update built on Electron's `autoUpdater` (Squirrel.Mac on
// darwin, Squirrel on win32). We point the feed at
// update.electronjs.org, which already filters to the latest non-draft,
// non-prerelease GitHub release and does the version comparison for us
// -- the renderer just sees a small state machine and a button.
//
// We deliberately replace `update-electron-app`'s OS dialog: the
// "Restart to update" prompt lives in Settings and a dot on the sidebar
// settings cog, so updates feel native to the app rather than to the OS.
//
// Override `SHIGOMORI_UPDATE_FEED_URL` to point the autoUpdater at a
// local server or alternate repo for end-to-end testing of a signed
// build. Ignored in dev mode (autoUpdater refuses dev builds anyway).
import { app, autoUpdater } from "electron";
import { updaterContract } from "@shared/ipc/modules/updater/contract";
import type { UpdaterState } from "@shared/schemas";
import { setUpdaterImpl } from "../ipc/modules/updater/handlers";
import { broadcastAll } from "../ipc/register";
import { confirmBusyAction } from "./busyPrompt";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);

let state: UpdaterState = { kind: "idle" };
let started = false;
let installing = false;
let intervalHandle: NodeJS.Timeout | null = null;

// quitAndInstall() stages Squirrel's ShipIt helper and then calls
// app.quit(), which still emits before-quit. The app-wide before-quit
// handler in index.ts intercepts that to reap orphan scripts; if its
// cleanup ever stalls the update never lands. This flag lets that
// handler bail out and let the natural quit through.
export function isInstallingUpdate(): boolean {
  return installing;
}

function setState(next: UpdaterState): void {
  state = next;
  broadcastAll(updaterContract, "state", state);
}

export function getUpdaterState(): UpdaterState {
  return state;
}

function buildFeedUrl(): string | null {
  const override = process.env.SHIGOMORI_UPDATE_FEED_URL?.trim();
  if (override) return override;
  if (!SUPPORTED_PLATFORMS.has(process.platform)) return null;
  return `https://update.electronjs.org/sylophi/shigoto-no-mori/${process.platform}-${process.arch}/${app.getVersion()}`;
}

function stripVPrefix(name: string): string {
  return name.startsWith("v") ? name.slice(1) : name;
}

export function checkForUpdates(): void {
  if (!started) return;
  // Keep polling while an update is staged so a newer release can replace
  // it; the event guards below preserve the "ready" UI during that poll.
  // Skip while a download is mid-flight so we don't pile on requests.
  if (state.kind === "downloading") return;
  if (state.kind !== "ready") setState({ kind: "checking" });
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function installUpdate(): Promise<void> {
  if (state.kind !== "ready") return;
  if (!(await confirmBusyAction("restart"))) return;
  // The dialog can sit open arbitrarily long; an autoUpdater error event
  // during that window flips state away from "ready" unconditionally.
  if (state.kind !== "ready") return;
  installing = true;
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    installing = false;
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function installUpdaterImpl(): void {
  setUpdaterImpl({
    getState: getUpdaterState,
    check: checkForUpdates,
    install: installUpdate,
  });
}

export function startUpdater(): void {
  if (started) return;
  if (!app.isPackaged) return;
  const feedUrl = buildFeedUrl();
  if (!feedUrl) return;

  try {
    autoUpdater.setFeedURL({
      url: feedUrl,
      headers: { "User-Agent": `shigoto-no-mori/${app.getVersion()}` },
    });
  } catch (err) {
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  autoUpdater.on("checking-for-update", () => {
    if (state.kind !== "ready") setState({ kind: "checking" });
  });
  autoUpdater.on("update-available", () => {
    if (state.kind !== "ready") setState({ kind: "downloading" });
  });
  autoUpdater.on("update-not-available", () => {
    if (state.kind !== "ready") setState({ kind: "idle" });
  });
  autoUpdater.on(
    "update-downloaded",
    (_event, releaseNotes, releaseName, releaseDate) => {
      setState({
        kind: "ready",
        version: stripVPrefix(releaseName ?? ""),
        notes: releaseNotes || undefined,
        releaseDate: releaseDate ? new Date(releaseDate).toISOString() : null,
      });
    },
  );
  autoUpdater.on("error", (err) => {
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  started = true;
  checkForUpdates();
  intervalHandle = setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

export function stopUpdater(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
