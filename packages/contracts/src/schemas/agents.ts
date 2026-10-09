import * as Schema from "effect/Schema";

// One agent harness's hooks on a host (`sm agents status`): whether the
// harness is set up there at all (its config dir exists), the hooks
// file, and whether the hooks that report its sessions are installed,
// installed by another build (outdated: install again) or missing.
// trusted is set for a harness that runs a hook only once the user has
// trusted it (Codex), once installed.
const AgentHarnessStatusSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detected: Schema.Boolean,
  path: Schema.String,
  hooks: Schema.Literals(["installed", "outdated", "missing"]),
  trusted: Schema.optional(Schema.Boolean),
});
export type AgentHarnessStatus = typeof AgentHarnessStatusSchema.Type;

export const AgentHarnessStatusListSchema = Schema.Array(
  AgentHarnessStatusSchema,
);

export const SetAgentHooksPayloadSchema = Schema.Struct({
  harness: Schema.String,
  install: Schema.Boolean,
});
