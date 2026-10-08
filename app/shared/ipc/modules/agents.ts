import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";

// One agent harness's hooks on a host (`sm agents status`): whether the
// harness is set up there at all (its config dir exists), the hooks
// file, and whether the hooks that report its sessions are installed,
// installed by another build (outdated: install again) or missing.
// trusted is set for a harness that runs a hook only once the user has
// trusted it (Codex), once installed.
export const AgentHarnessStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  detected: z.boolean(),
  path: z.string(),
  hooks: z.enum(["installed", "outdated", "missing"]),
  trusted: z.boolean().optional(),
});
export type AgentHarnessStatus = z.infer<typeof AgentHarnessStatusSchema>;

const HarnessesSchema = z.array(AgentHarnessStatusSchema);

// Gated like the CLI's own install: the statuses name the host's home,
// and installing edits files in it. Hooks are no part of the forest
// state a ping re-reads, so none pings viewers.
const gated = { remote: true, gated: true, movesHostState: false };

export const agentsContract = defineContract("host", {
  status: invoke("agents:status", z.void(), HarnessesSchema, gated),
  // Installs or removes one harness's hooks.
  setHooks: invoke(
    "agents:setHooks",
    z.object({ harness: z.string(), install: z.boolean() }),
    HarnessesSchema,
    gated,
  ),
});
