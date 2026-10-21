import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  DetectedLauncherSchema,
  LauncherEntrySchema,
  LaunchPayloadSchema,
  OpenFilePayloadSchema,
  ProjectScopedPayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Tagged host: launch executes where the project files live, which is
// the host by design, and a GUI app it starts opens on that machine.
export const launchersContract = defineContract(
  "launchers",
  "host",
  invoke("detect", VoidSchema, Schema.Array(DetectedLauncherSchema), {
    remote: true,
    gated: false,
  }),
  invoke(
    "forProject",
    ProjectScopedPayloadSchema,
    Schema.Struct({
      entries: Schema.Array(LauncherEntrySchema),
      // How many resolvable entries the user's hidden list filtered out.
      // Lets the row tell "nothing installed" apart from "you hid it all"
      // without re-deriving the filter in the renderer.
      hiddenCount: Schema.Natural,
    }),
    { remote: true, gated: false },
  ),
  // launch is remote false: it spawns an arbitrary shell command from
  // config, the one clear remote code execution vector. Detection is safe to serve, launching is not.
  invoke("launch", LaunchPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: false,
  }),
  // A worktree's file in this machine's editor, like launch: what
  // opens is this machine's.
  invoke("openFile", OpenFilePayloadSchema, VoidSchema, {
    remote: false,
  }),
);
