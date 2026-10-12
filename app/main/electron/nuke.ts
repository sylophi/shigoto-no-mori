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
import { app } from "electron";
import type { NukeReport } from "@shigomori/contracts/schemas";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  dataDirPointerPath,
  legacyDataDirPointerPath,
} from "@shared/packaging/cliDist.mts";
import { dataDir, dataDirSource } from "@shared/paths";
import { writeNukeMarker } from "../core/nuke/finish";
import { signOutForNuke } from "../ipc/modules/account";
import { flavor } from "../flavor";

// What goes at the next start besides userData: the data dir, the logs,
// and the pointer that found the data dir. A data dir set by
// SHIGOMORI_DATA_DIR (a dev profile) came from no pointer, and the
// flavor's pointer is another instance's then.
function pathsToDelete(): string[] {
  const pointers =
    dataDirSource() === "env"
      ? []
      : [dataDirPointerPath(flavor), legacyDataDirPointerPath(flavor)];
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
  if (process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: false });
  }
  writeNukeMarker(app.getPath("userData"), pathsToDelete());
  return { left };
}
