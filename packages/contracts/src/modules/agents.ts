import { defineContract, invoke } from "../contract.ts";
import {
  AgentHarnessStatusListSchema,
  SetAgentHooksPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Gated like the terminal's own install: the statuses name the host's
// home, and installing edits files in it.
export const agentsContract = defineContract(
  "agents",
  "host",
  invoke("status", VoidSchema, AgentHarnessStatusListSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
  // Installs or removes one harness's hooks.
  invoke("setHooks", SetAgentHooksPayloadSchema, AgentHarnessStatusListSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
);
