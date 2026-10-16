// "Nuke everything" with no window, for `<binary> nuke` (the CLI starts
// the bundle with --sm-nuke): the host's half and the shell's, as the
// Danger zone runs them, then an exit that tells the command to start
// the app again, whose start deletes the files the marker names
// (core/nuke/finish.ts) and what only a start with nothing open can:
// the keychain item and the preferences.
import { execFileSync } from "node:child_process";
import { app } from "electron";
import * as Effect from "effect/Effect";
import { NUKE_EXIT, NUKE_SWITCH } from "@shigomori/engine/footprint";
import { log } from "@shared/log";
import { deleteGenericPassword } from "../core/keychain/security";
import { safeStorageItemNames } from "../core/keychain/reset";
import { names } from "../flavor";
import { hostRuntime, letHostGo } from "../hostProcess";
import { nukeShell } from "./nuke";

export const headless = app.commandLine.hasSwitch(NUKE_SWITCH);

// The start that found the marker: what is left once its files are gone.
export function finishHeadlessNuke(): void {
  if (__SM_SIGNED_MAC_BUILD__) {
    const { service, account } = safeStorageItemNames(app.getName());
    try {
      deleteGenericPassword(service, account);
    } catch (error) {
      console.log(`[nuke] left: the keychain item "${service}": ${error}`);
    }
  }
  try {
    execFileSync("/usr/bin/defaults", ["delete", names.bundleId], {
      stdio: "ignore",
    });
  } catch {
    // None written.
  }
  app.exit(NUKE_EXIT.finished);
}

// The live halves, once the host is up.
export async function runHeadlessNuke(): Promise<void> {
  try {
    const host = await Effect.runPromise(hostRuntime().nuke());
    const shell = await nukeShell();
    const left = [...host.left, ...shell.left];
    for (const { what, why } of left)
      console.log(`[nuke] left: ${what}: ${why}`);
    letHostGo();
    app.exit(left.length === 0 ? NUKE_EXIT.again : NUKE_EXIT.againWithLeft);
  } catch (error) {
    log.error("[nuke] could not nuke:", error);
    letHostGo();
    app.exit(1);
  }
}
