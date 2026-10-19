import * as Schema from "effect/Schema";
import { push, defineContract, invoke } from "../contract.ts";
import { ProjectScopedPayloadSchema, VoidSchema } from "../schemas/index.ts";

export const gitContract = defineContract(
  "git",
  "host",
  // Gated: it always ends in an auto-pull pass, which fast-forwards the
  // marked worktrees.
  invoke("refreshProject", ProjectScopedPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
  }),
  // refreshProject a person asked for (the page's refresh), which a quit
  // waits on as it does on any git work someone started.
  invoke("fetchProject", ProjectScopedPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeCode",
    busy: "fetch",
  }),
  // A peer looking at this host: runs the background sweep if stale and
  // keeps it ticking for the returned lease. Read-class: a request only
  // decides when the host's own pass runs, never more often than its
  // interval.
  invoke(
    "sweep",
    Schema.Struct({ renewal: Schema.Boolean }),
    Schema.Struct({ leaseMs: Schema.Finite }),
    { remote: true, gated: false },
  ),
  push("refsRefreshed", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  push(
    "fetchActive",
    Schema.Struct({
      ...ProjectScopedPayloadSchema.fields,
      active: Schema.Boolean,
    }),
    { remote: true },
  ),
  // Refetch-on-focus can't cover this: an agent may work in a terminal
  // beside a focused window.
  push("externalChange", VoidSchema, { remote: true }),
  // Narrower than externalChange on purpose, so it stays cheap enough to
  // be redundant beside a mutation's own invalidation.
  push("projectChanged", ProjectScopedPayloadSchema, {
    remote: true,
  }),
);
