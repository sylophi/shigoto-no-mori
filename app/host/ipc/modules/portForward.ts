import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import type { EffectHandlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Effect from "effect/Effect";
import { PortForwards } from "@host/portForward/PortForwards";
import type { HostServices } from "@host/process/services";

// Thin shell over the engine (host/portForward/PortForwards.ts).
export const portForwardHandlers = {
  start: (input) =>
    Effect.flatMap(PortForwards, (engine) => engine.startForward(input)),
  stop: ({ forwardId }) =>
    Effect.flatMap(PortForwards, (engine) => engine.stopForward(forwardId)),
  list: () =>
    Effect.map(PortForwards, (engine) => ({ forwards: engine.listForwards() })),
} satisfies EffectHandlers<
  typeof portForwardContract,
  HandlerContext,
  HostServices
>;
