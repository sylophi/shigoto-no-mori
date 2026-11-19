// The port forwards this device runs onto its peers (engine.ts), for
// the length of the graph. Their peer reach is the same seam as every
// other (host/ipc/PeerReach.ts) and for the same reason: a second
// session would supersede the one the renderer's remote-forest queries
// ride.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { makePortForwardEngine, type PortForwardEngine } from "./engine";

export class PortForwards extends Context.Service<
  PortForwards,
  PortForwardEngine
>()("sm/host/PortForwards") {}

// Every forward is a scope of the layer's, so the graph closing stops
// them all, and a start under way as it closes leaves nothing bound.
// Their changes go to every window.
export const layer = Layer.effect(PortForwards, makePortForwardEngine);
