import { agentsContract } from "@shared/ipc/modules/agents";
import type { Handlers } from "@shared/ipc/types";
import {
  agentHarnessesViaCli,
  setAgentHooksViaCli,
} from "@host/ipc/cliDelegate";

export const agentsHandlers: Handlers<typeof agentsContract> = {
  status: () => agentHarnessesViaCli(),
  setHooks: ({ harness, install }) => setAgentHooksViaCli(harness, install),
};
