import { portForwardContract } from "@shared/ipc/modules/portForward";
import type { Handlers } from "@shared/ipc/types";
import type { PortForwardEngine } from "../../core/portForward/engine";
import { implSlot } from "@host/lib/util/implSlot";

// Thin shell over the engine (main/core/portForward/engine.ts), injected at
// boot following the setUpdaterImpl precedent: the wiring (the
// bridge's direct peer sessions, the changed broadcast) lives in
// main/ipc/handlers.ts, so this module stays a pure handler map.
const {
  set: setPortForwardEngine,
  get: engine,
  orNull: engineOrNull,
} = implSlot<PortForwardEngine>(
  "port-forward handler invoked before the engine was wired",
);
export { setPortForwardEngine };

export const portForwardHandlers: Handlers<typeof portForwardContract> = {
  start: (input) => engine().startForward(input),
  stop: ({ forwardId }) => {
    engine().stopForward(forwardId);
  },
  list: () => ({ forwards: engine().listForwards() }),
};

// Quit-path teardown (main/index.ts before-quit): the listeners die
// with the process anyway, but stopping here also best-effort closes
// the host-side conns so the peer is not left waiting out its idle
// sweep. Safe before wiring: a boot that never reached the engine has
// nothing to stop.
export function stopAllPortForwards(): void {
  engineOrNull()?.stopAll();
}

// The forwards onto devices no longer on the account, stopped (the
// account fan-out's listDevices hook in main/ipc/handlers.ts).
export function stopPortForwardsTo(keep: (deviceId: string) => boolean): void {
  engineOrNull()?.stopForwardsTo(keep);
}
