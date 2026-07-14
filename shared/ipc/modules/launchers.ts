import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  DetectedLauncherSchema,
  LauncherEntrySchema,
  LaunchPayloadSchema,
  ProjectScopedPayloadSchema,
} from "@shared/schemas";

export const launchersContract = {
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
} as const;

export type LaunchersContract = typeof launchersContract;
