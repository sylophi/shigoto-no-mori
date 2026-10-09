// What the host asks of the shell that started it: the few things only
// Electron's process can do (decision 6 of V3.md keeps the updater and
// the app's own lifetime there). Wired by the shell as the host starts
// (main/hostProcess.ts).
import type { UpdaterState } from "@shigomori/contracts/schemas";
import { implSlot } from "@host/lib/util/implSlot";

export type ShellCalls = {
  // Restarts the app with nobody at it to answer a prompt: after a
  // data-folder move a peer asked for.
  readonly relaunch: () => Promise<void>;
  // The updater, which a peer's Settings page reads and drives here.
  // `unattended` marks a call another device made: a busy host refuses
  // it instead of prompting a screen nobody watches.
  readonly updater: {
    readonly check: () => Promise<void>;
    readonly install: (unattended: boolean) => Promise<void>;
    readonly update: (unattended: boolean) => Promise<void>;
  };
  // The bridge the terminal's `sm update` asks the updater through,
  // stopped before a wipe of the data folder it lives in.
  readonly stopUpdaterBridge: () => Promise<void>;
};

const { set: setShellCalls, get: shellCalls } = implSlot<ShellCalls>(
  "the host called its shell before the shell wired itself in",
);
export { setShellCalls, shellCalls };

// The updater's state as the shell last reported it (session.ts), so a
// peer's read is answered here without a round trip.
let updaterState: UpdaterState = { kind: "idle" };

export function lastUpdaterState(): UpdaterState {
  return updaterState;
}

export function noteUpdaterState(state: UpdaterState): void {
  updaterState = state;
}
