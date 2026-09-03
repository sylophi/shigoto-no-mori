import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { ProjectScopedPayloadSchema } from "@shared/schemas/payloads";

export const gitContract = defineContract("host", {
  // mutating: it spawns git and performs a network fetch, so it counts
  // as a command rather than a pure read even though the caller reads
  // the refreshed refs afterward.
  refreshProject: invoke(
    "git:refreshProject",
    ProjectScopedPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
  refsRefreshed: broadcast("git:refsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  fetchActive: broadcast(
    "git:fetchActive",
    ProjectScopedPayloadSchema.extend({ active: z.boolean() }),
    { remote: true },
  ),
  // Something outside the app (the CLI) changed worktrees or state
  // on disk. The renderer invalidates its queries -- refetch-on-focus
  // can't cover this, since the window may already be focused while an
  // agent works in a terminal beside it.
  externalChange: broadcast("git:externalChange", z.void(), { remote: true }),
  // One project's git state moved (a commit, checkout, branch or ref
  // change made by any tool, observed by the host's git-directory
  // watcher, main/electron/gitWatcher.ts). Narrower than
  // externalChange on purpose: the viewer invalidates that project's
  // rows only, on every device, so the ping stays cheap enough to be
  // redundant beside an app-driven mutation's own invalidation.
  projectChanged: broadcast("git:projectChanged", ProjectScopedPayloadSchema, {
    remote: true,
  }),
});
