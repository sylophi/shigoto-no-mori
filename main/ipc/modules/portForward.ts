import { Context } from "effect";
import { portForwardContract } from "@shared/ipc/modules/portForward";
import type { Handlers } from "@shared/ipc/types";
import type { PortForwardEngine as Engine } from "../../core/portForward/engine";
import { hostService, hostServiceOrNull } from "@host/runtime";

// Thin shell over the engine (main/core/portForward/engine.ts),
// provided on the app runtime like the host's services: the wiring
// (the bridge's direct peer sessions, the changed broadcast) is its
// layer in main/ipc/handlers.ts, so this module stays a pure handler
// map.
export class PortForwardEngine extends Context.Service<
  PortForwardEngine,
  Engine
>()("sm/main/PortForwardEngine") {}

function engine(): Engine {
  return hostService(
    PortForwardEngine,
    "port-forward handler invoked before the runtime provided the engine",
  );
}

export const portForwardHandlers: Handlers<typeof portForwardContract> = {
  start: (input) => engine().startForward(input),
  stop: ({ forwardId }) => {
    engine().stopForward(forwardId);
  },
  list: () => ({ forwards: engine().listForwards() }),
};

// The forwards onto devices no longer on the account, stopped (the
// account fan-out's listDevices hook in main/ipc/handlers.ts).
export function stopPortForwardsTo(keep: (deviceId: string) => boolean): void {
  hostServiceOrNull(PortForwardEngine)?.stopForwardsTo(keep);
}
