import { Schema } from "effect";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { ProjectScopedPayloadSchema } from "@shared/schemas/payloads";

export const gitContract = defineContract("host", {
  // mutating: beyond the fetch (a cache refresh, read-class on its
  // own) it always ends in an auto-pull pass, which fast-forwards the
  // project's marked worktrees, and it does so on every call.
  refreshProject: invoke(
    "git:refreshProject",
    ProjectScopedPayloadSchema,
    Schema.Undefined,
    { remote: true, mutating: true },
  ),
  // A peer saying it is looking at this host: runs the host's
  // background sweep (refs and PRs, every project) if it is stale, and
  // keeps the host's sweep timer ticking for the returned lease. The
  // peer renews within that lease while its window stays focused.
  // Read-class: the sweep is the host's own scheduled pass, including
  // the auto-pulls the host's user marked for it, and a request only
  // decides when it runs, never more often than its interval.
  sweep: invoke(
    "git:sweep",
    Schema.Undefined,
    Schema.Struct({ leaseMs: Schema.Finite }),
    {
      remote: true,
      mutating: false,
    },
  ),
  refsRefreshed: broadcast("git:refsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  fetchActive: broadcast(
    "git:fetchActive",
    Schema.Struct({
      ...ProjectScopedPayloadSchema.fields,
      active: Schema.Boolean,
    }),
    { remote: true },
  ),
  // Something outside the app (the CLI) changed worktrees or state
  // on disk. The renderer invalidates its queries. Refetch-on-focus
  // can't cover this, since the window may already be focused while an
  // agent works in a terminal beside it.
  externalChange: broadcast("git:externalChange", Schema.Undefined, {
    remote: true,
  }),
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
