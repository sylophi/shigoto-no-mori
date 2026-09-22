import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { ProjectScopedPayloadSchema } from "@shared/schemas/payloads";

export const gitContract = defineContract("host", {
  // Read-class: a fetch of remote-tracking refs refreshes a cache the
  // host keeps for itself, and it is bounded by the host's freshness
  // window (main/electron/fetch.ts). Nothing the user owns moves.
  refreshProject: invoke(
    "git:refreshProject",
    ProjectScopedPayloadSchema,
    z.void(),
    { remote: true, mutating: false },
  ),
  // A peer saying it is looking at this host: runs the host's
  // background sweep (refs and PRs, every project) if it is stale, and
  // keeps the host's sweep timer ticking for the returned lease. The
  // peer renews within that lease while its window stays focused.
  sweep: invoke("git:sweep", z.void(), z.object({ leaseMs: z.number() }), {
    remote: true,
    mutating: false,
  }),
  refsRefreshed: broadcast("git:refsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  fetchActive: broadcast(
    "git:fetchActive",
    ProjectScopedPayloadSchema.extend({ active: z.boolean() }),
    { remote: true },
  ),
  // Something outside the app (the CLI) changed worktrees or state
  // on disk. The renderer invalidates its queries. Refetch-on-focus
  // can't cover this, since the window may already be focused while an
  // agent works in a terminal beside it.
  externalChange: broadcast("git:externalChange", z.void(), { remote: true }),
  // One project's git state moved (a commit, checkout, branch or ref
  // change made by any tool, observed by the host's git-directory
  // watcher, main/core/gitWatcher.ts). Narrower than
  // externalChange on purpose: the viewer invalidates that project's
  // rows only, on every device, so the ping stays cheap enough to be
  // redundant beside an app-driven mutation's own invalidation.
  projectChanged: broadcast("git:projectChanged", ProjectScopedPayloadSchema, {
    remote: true,
  }),
});
