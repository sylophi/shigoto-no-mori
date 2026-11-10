import { defineContract, invoke, gatedBy } from "../contract.ts";
import {
  AgentHarnessStatusListSchema,
  SetAgentHooksPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Gated like the terminal's own install: the statuses name the host's
// home, and installing edits files in it.
export const agentsContract = defineContract(
  "agents",
  { scope: "host", version: 1 },
  invoke(
    "status",
    VoidSchema,
    AgentHarnessStatusListSchema,
    gatedBy("changeApp"),
  ),
  // Installs or removes one harness's hooks.
  invoke(
    "setHooks",
    SetAgentHooksPayloadSchema,
    AgentHarnessStatusListSchema,
    gatedBy("changeApp"),
  ),
);
