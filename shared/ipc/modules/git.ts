import { z } from "zod";
import { broadcast } from "@shared/ipc/contract";

export const gitContract = {
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
