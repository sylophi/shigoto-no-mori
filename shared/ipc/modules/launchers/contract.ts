import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
  DetectedLauncherSchema,
  LauncherEntrySchema,
  LaunchPayloadSchema,
  ReadShigomoriPayloadSchema,
} from "@shared/schemas";

// LaunchersForProject reuses ReadShigomoriPayloadSchema since both
// surfaces accept `{ projectId }`.
export const launchersContract = {
  detect: invoke("launchers:detect", z.void(), z.array(DetectedLauncherSchema)),
  forProject: invoke(
    "launchers:forProject",
    ReadShigomoriPayloadSchema,
    z.object({ entries: z.array(LauncherEntrySchema) }),
  ),
  launch: invoke("launchers:launch", LaunchPayloadSchema, z.void()),
} as const;

export type LaunchersContract = typeof launchersContract;
