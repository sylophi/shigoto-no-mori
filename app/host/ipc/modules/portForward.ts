import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import type { Handlers } from "@shigomori/contracts/types";
import type { PortForwardEngine } from "@host/portForward/engine";
import { implSlot } from "@host/lib/util/implSlot";

// Thin shell over the engine (host/portForward/engine.ts), injected at
// start: the wiring (the bridge's direct peer sessions, the changed
// broadcast) lives in host/process/handlers.ts, so this module stays a
// pure handler map.
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

// Quit's teardown (host/process/layer.ts): the listeners die
// with the process anyway, but stopping here also best-effort closes
// the host-side conns so the peer is not left waiting out its idle
// sweep. Safe before wiring: a boot that never reached the engine has
// nothing to stop.
export function stopAllPortForwards(): void {
  engineOrNull()?.stopAll();
}

// The forwards onto devices no longer on the account, stopped (the
// account fan-out's device list in host/process/handlers.ts).
export function stopPortForwardsTo(keep: (deviceId: string) => boolean): void {
  engineOrNull()?.stopForwardsTo(keep);
}
