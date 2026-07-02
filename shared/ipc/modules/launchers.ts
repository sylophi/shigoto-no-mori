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
    z.object({ entries: z.array(LauncherEntrySchema) }),
  ),
  launch: invoke("launchers:launch", LaunchPayloadSchema, z.void(), {
    tracksProjectUsage: true,
  }),
} as const;

export type LaunchersContract = typeof launchersContract;
