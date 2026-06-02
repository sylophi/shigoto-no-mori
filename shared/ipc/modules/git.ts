import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";

export const gitContract = {
  refreshProject: invoke(
    "git:refreshProject",
    z.object({ projectId: z.string() }),
    z.void(),
  ),
  refsRefreshed: broadcast(
    "git:refsRefreshed",
    z.object({ projectId: z.string() }),
  ),
  fetchActive: broadcast(
    "git:fetchActive",
    z.object({ projectId: z.string(), active: z.boolean() }),
  ),
} as const;

export type GitContract = typeof gitContract;
