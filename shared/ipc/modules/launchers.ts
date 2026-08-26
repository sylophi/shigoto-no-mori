import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  DetectedLauncherSchema,
  LauncherEntrySchema,
  LaunchPayloadSchema,
  ProjectScopedPayloadSchema,
} from "@shared/schemas";

// Tagged host: launch executes where the project files live, which is
// the host by design. Which launcher kinds make sense against a remote
// host is deliberately unresolved until the remote-actions step, since
// stream or port-carried output can travel but a GUI app opens on the
// host machine.
export const launchersContract = defineContract("host", {
  detect: invoke("launchers:detect", z.void(), z.array(DetectedLauncherSchema)),
  forProject: invoke(
    "launchers:forProject",
    ProjectScopedPayloadSchema,
    z.object({
      entries: z.array(LauncherEntrySchema),
      // How many resolvable entries the user's hidden list filtered out.
      // Lets the row tell "nothing installed" apart from "you hid it all"
      // without re-deriving the filter in the renderer.
      hiddenCount: z.number().int().nonnegative(),
    }),
  ),
  launch: invoke("launchers:launch", LaunchPayloadSchema, z.void(), {
    tracksProjectUsage: true,
  }),
});
