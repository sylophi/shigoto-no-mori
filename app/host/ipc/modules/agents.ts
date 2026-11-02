import { agentsContract } from "@shigomori/contracts/modules/agents";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Agents from "@shigomori/engine/Agents";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/Engine";

export const agentsHandlers = {
  status: () => Effect.flatMap(Agents.Agents, (agents) => agents.statuses),
  // Answered with every harness's status.
  setHooks: ({ harness, install }) =>
    Effect.gen(function* () {
      const agents = yield* Agents.Agents;
      yield* agents.setHooks([harness], install);
      return yield* agents.statuses;
    }),
} satisfies EffectHandlers<typeof agentsContract, unknown, Engine.Services>;
