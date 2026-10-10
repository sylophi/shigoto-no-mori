import { agentsContract } from "@shigomori/contracts/modules/agents";
import type { Handlers } from "@shigomori/contracts/types";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";

export const agentsHandlers = {
  status: () => Ops.agentHarnesses(),
  setHooks: ({ harness, install }) => Ops.setAgentHooks(harness, install),
} satisfies Handlers<typeof agentsContract, unknown, Engine.Services>;
