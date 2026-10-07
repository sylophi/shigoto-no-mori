import * as Schema from "effect/Schema";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  DetectedLauncherSchema,
  LauncherEntrySchema,
  LaunchPayloadSchema,
  ProjectScopedPayloadSchema,
  VoidSchema,
} from "@shared/schemas";

// Tagged host: launch executes where the project files live, which is
// the host by design. Which launcher kinds make sense against a remote
// host is deliberately unresolved until the remote-actions step, since
// stream or port-carried output can travel but a GUI app opens on the
// host machine.
export const launchersContract = defineContract("host", {
  detect: invoke(
    "launchers:detect",
    VoidSchema,
    Schema.Array(DetectedLauncherSchema),
    {
      remote: true,
      gated: false,
    },
  ),
  forProject: invoke(
    "launchers:forProject",
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
  launch: invoke("launchers:launch", LaunchPayloadSchema, VoidSchema, {
    tracksProjectUsage: true,
    remote: false,
  }),
});
