import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { PortForwardEngine } from "@host/portForward/engine";
import { implSlot } from "@host/lib/util/implSlot";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";

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

export const portForwardHandlers: EffectHandlers<typeof portForwardContract> = {
  start: (input) =>
    Effect.tryPromise({
      try: () => engine().startForward(input),
      catch: callFailureOf,
    }),
  stop: ({ forwardId }) => Effect.sync(() => engine().stopForward(forwardId)),
  list: () => Effect.sync(() => ({ forwards: engine().listForwards() })),
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
