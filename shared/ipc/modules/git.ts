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
  // Something outside the app (the sgm CLI) changed worktrees or state
  // on disk. The renderer invalidates its queries -- refetch-on-focus
  // can't cover this, since the window may already be focused while an
  // agent works in a terminal beside it.
  externalChange: broadcast("git:externalChange", z.void()),
} as const;

export type GitContract = typeof gitContract;
