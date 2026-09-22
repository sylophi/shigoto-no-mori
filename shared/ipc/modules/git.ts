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
  // A peer asking this host to run its background sweep now (refs and
  // PRs for every project), because the peer's window just focused or
  // its session just landed. Read-class on purpose: the host runs the
  // same sweep unprompted whenever its own window is focused, so a
  // request moves it earlier and nothing else, the host's freshness
  // window bounds the rate, and gating it on a command grant would
  // leave a read-only viewer looking at whatever the host last saw.
  // Resolves as soon as the sweep is started, not when it finishes.
  // The results arrive as refsRefreshed and
  // projectPullRequestsRefreshed pushes, like any other sweep's.
  sweep: invoke("git:sweep", z.void(), z.void(), {
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
