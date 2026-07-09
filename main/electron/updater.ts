// In-app auto-update built on Electron's `autoUpdater` (Squirrel.Mac).
// We point the feed at update.electronjs.org, which already filters to
// the latest non-draft, non-prerelease GitHub release and does the
// version comparison for us -- the renderer just sees a small state
// machine and a button.
//
// macOS-only: the Windows build is a portable zip with no installer,
// and Electron's Windows autoUpdater only works under a Squirrel
// install. Windows (and dev) builds report `unsupported` so the
// renderer can hide the check button instead of showing a dead one.
//
// We deliberately replace `update-electron-app`'s OS dialog: the
// "Restart to update" prompt lives in Settings and a dot on the sidebar
// settings cog, so updates feel native to the app rather than to the OS.
//
// Override `SHIGOMORI_UPDATE_FEED_URL` to point the autoUpdater at a
// local server or alternate repo for end-to-end testing of a signed
// build. Ignored in dev mode (autoUpdater refuses dev builds anyway).
import { app, autoUpdater } from "electron";
import { updaterContract } from "@shared/ipc/modules/updater";
import type { UpdaterState } from "@shared/schemas";
import { setUpdaterImpl } from "../ipc/modules/updater";
import { broadcastAll } from "../ipc/register";
import { isMac } from "../lib/util/platform";
import { confirmBusyAction } from "./busyPrompt";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

let state: UpdaterState = { kind: "idle" };
let started = false;
let installing = false;

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
  if (!isMac) return null;
  const override = process.env.SHIGOMORI_UPDATE_FEED_URL?.trim();
  if (override) return override;
  return `https://update.electronjs.org/sylophi/shigoto-no-mori/darwin-${process.arch}/${app.getVersion()}`;
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
  const feedUrl = app.isPackaged ? buildFeedUrl() : null;
  if (!feedUrl) {
    setState({ kind: "unsupported" });
    return;
  }

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
      // Squirrel can hand us an Invalid Date (truthy!) when the feed's
      // pubDate is malformed; toISOString() on it throws, and a throw in
      // this listener would surface as an uncaught exception and leave
      // the state machine stuck before "ready".
      const parsedDate = releaseDate ? new Date(releaseDate) : null;
      const releaseDateIso =
        parsedDate && !Number.isNaN(parsedDate.getTime())
          ? parsedDate.toISOString()
          : null;
      setState({
        kind: "ready",
        version: stripVPrefix(releaseName ?? ""),
        notes: releaseNotes || undefined,
        releaseDate: releaseDateIso,
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
  // Runs for the app's lifetime; quit tears the interval down with the
  // process, so there's no stop path.
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}
