import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
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

const client = buildClient(launchersContract);

export const launchers = {
  detected: () => client.detect(),
  forProject: (projectId: string) => client.forProject({ projectId }),
  launch: client.launch,
} as const;
