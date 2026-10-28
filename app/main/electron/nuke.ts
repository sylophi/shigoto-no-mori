// The shell's half of "Nuke everything", after the host's
// (host/lib/nuke.ts): this device revoked on the hub and signed out,
// launch at login off, and a marker in userData naming the files to
// delete. The files go at the next start, first thing after the
// single-instance lock and before anything opens them: the data dir
// (the store, the terminals' saved rings, file-sync's state, the
// caches), the data dir's pointer, the logs, and everything in
// userData (the Clerk tokens, the hub credential, the client config,
// Chromium's storage), the marker last. So that start is a fresh
// install, and a start that dies halfway through finds the marker and
// deletes the rest. A signed build's keychain item goes with the marker
// beside it (main/core/keychain/reset.ts recreates its own once that
// marker is gone).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, shell } from "electron";
import type { NukeReport } from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  dataDir,
  dataDirPointerPath,
  dataDirSource,
  legacyDataDirPointerPath,
} from "@shared/paths";
import { NUKE_MARKER, writeNukeMarker } from "../core/nuke/finish";
import { names } from "../flavor";
import { signOutForNuke } from "./account";
import { setsLoginItem } from "./liveness";
import { current as currentPlatform } from "@shigomori/engine/platform";

// What goes at the next start besides userData: the data dir, the logs,
// and the pointer that found the data dir. A data dir set by
// SHIGOMORI_DATA_DIR (a dev profile) came from no pointer, and the
// flavor's pointer is another instance's then.
function pathsToDelete(): string[] {
  const pointers =
    dataDirSource() === "env"
      ? []
      : [dataDirPointerPath(), legacyDataDirPointerPath()];
  return [
    dataDir(),
    app.getPath("logs"),
    ...pointers.filter((path) => path !== null),
  ];
}

export async function nukeShell(): Promise<NukeReport> {
  const left: NukeReport["left"][number][] = [];
  try {
    const failure = await signOutForNuke();
    if (failure !== null) {
      left.push({
        what: "This device on your account",
        why: `${failure} Remove it from another device's account page.`,
      });
    }
  } catch (error) {
    left.push({
      what: "This device on your account",
      why: errorMessageOf(error),
    });
  }
  if (currentPlatform() === "darwin" && setsLoginItem()) {
    app.setLoginItemSettings({ openAtLogin: false });
  }
  writeNukeMarker(app.getPath("userData"), pathsToDelete());
  return { left };
}

// A start whose nuke left files it couldn't delete: run on, it would
// delete at its next start what it made meanwhile. Whether to open
// anyway, the marker dropped (the person's call, on what is left), or
// to quit, revealing the first file to delete.
export async function openPastStuckNuke(
  left: readonly { readonly path: string; readonly why: string }[],
): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: `${names.appName} couldn't finish erasing itself`,
    detail: `${left.map((stayed) => `${stayed.path}: ${stayed.why}`).join("\n")}\n\nDelete what's named here, then open the app again to finish.`,
    buttons: ["Show in Finder", "Open Without Finishing", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 1) {
    const marker = join(app.getPath("userData"), NUKE_MARKER);
    try {
      rmSync(marker, { force: true });
      return true;
    } catch (error) {
      dialog.showErrorBox(
        `${names.appName} couldn't open`,
        `${marker}: ${errorMessageOf(error)}`,
      );
      return false;
    }
  }
  const first = left[0];
  if (response === 0 && first !== undefined) shell.showItemInFolder(first.path);
  return false;
}
