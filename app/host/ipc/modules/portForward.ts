import { portForwardContract } from "@shigomori/contracts/modules/portForward";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import type { HandlerContext } from "@shared/ipc/transport";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import { PortForwards } from "@host/portForward/PortForwards";
import type { HostServices } from "@host/process/services";

// Thin shell over the engine (host/portForward/PortForwards.ts).
export const portForwardHandlers = {
  start: (input) =>
    Effect.flatMap(PortForwards, (engine) =>
      Effect.tryPromise({
        try: () => engine.startForward(input),
        catch: callFailureOf,
      }),
    ),
  stop: ({ forwardId }) =>
    Effect.map(PortForwards, (engine) => engine.stopForward(forwardId)),
  list: () =>
    Effect.map(PortForwards, (engine) => ({ forwards: engine.listForwards() })),
} satisfies EffectHandlers<
  typeof portForwardContract,
  HandlerContext,
  HostServices
>;
