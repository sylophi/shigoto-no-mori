// The port forwards this device runs onto its peers (engine.ts), for
// the length of the graph. Their peer reach is the same seam as every
// other (host/ipc/PeerReach.ts) and for the same reason: a second
// session would supersede the one the renderer's remote-forest queries
// ride.
import { forwardContract } from "@shigomori/contracts/modules/forward";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PeerReach } from "@host/ipc/PeerReach";
import { makePortForwardEngine, type PortForwardEngine } from "./engine";

export class PortForwards extends Context.Service<
  PortForwards,
  PortForwardEngine
>()("sm/host/PortForwards") {}

// The listeners die with the process anyway, but stopping them as the
// graph closes also best-effort closes the host-side conns, so the
// peer is not left waiting out its idle sweep.
export const layer = (options: { readonly onChange: () => void }) =>
  Layer.effect(
    PortForwards,
    Effect.gen(function* () {
      const reach = yield* PeerReach;
      const engine = yield* makePortForwardEngine({
        forwardApiFor: (deviceId) => reach.calls(forwardContract, deviceId),
        channelsFor: reach.channels,
        onChange: options.onChange,
      });
      yield* Effect.addFinalizer(() => Effect.sync(engine.stopAll));
      return engine;
    }),
  );
