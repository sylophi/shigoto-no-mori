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
import { app, autoUpdater, BrowserWindow } from "electron";
import { CHANNELS, type ChannelName } from "@shared/channels";
import type { UpdaterState } from "@shared/schemas";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);

let state: UpdaterState = { kind: "idle" };
let started = false;
let intervalHandle: NodeJS.Timeout | null = null;

function broadcast<T>(channel: ChannelName, payload: T): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function setState(next: UpdaterState): void {
  state = next;
  broadcast(CHANNELS.UpdaterState, state);
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
  // No-op once an update is ready -- the only useful action left is install.
  if (state.kind === "ready" || state.kind === "downloading") return;
  setState({ kind: "checking" });
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    setState({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export function installUpdate(): void {
  if (state.kind !== "ready") return;
  // quitAndInstall skips before-quit, which is fine here -- the
  // worktree-script reaper that lives there is best-effort cleanup,
  // and an update restart is effectively a fresh launch.
  autoUpdater.quitAndInstall();
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
