import { agentsContract } from "@shigomori/contracts/modules/agents";
import type { Handlers } from "@shigomori/contracts/types";
import { agentHarnesses, setAgentHooks } from "@host/lib/engineCalls";

export const agentsHandlers: Handlers<typeof agentsContract> = {
  status: () => agentHarnesses(),
  setHooks: ({ harness, install }) => setAgentHooks(harness, install),
};
