import { portForwardContract } from "@shared/ipc/modules/portForward";
import type { Handlers } from "@shared/ipc/types";
import type { PortForwardEngine } from "../../portForward/engine";

// Thin shell over the engine (main/portForward/engine.ts), injected at
// boot following the setUpdaterImpl precedent: the wiring (the
// bridge's direct peer sessions, the changed broadcast) lives in
// main/ipc/index.ts, so this module stays a pure handler map.
let impl: PortForwardEngine | null = null;

export function setPortForwardEngine(next: PortForwardEngine): void {
  impl = next;
}

function engine(): PortForwardEngine {
  if (impl === null) {
    throw new Error("port-forward handler invoked before the engine was wired");
  }
  return impl;
}

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
  impl?.stopAll();
}
