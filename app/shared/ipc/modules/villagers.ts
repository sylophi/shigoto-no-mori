import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  VillagerDataStatusSchema,
  VillagerProfilesSchema,
  VillagerSlugSchema,
} from "@shared/schemas";

// The villager data, as a HOST module: the faces and profiles are
// downloaded to, and served from, the device whose Settings asked
// (host/lib/villagers.ts). A peer's Settings tab reads that device's
// status and, when granted, downloads or removes there, and any device
// showing a peer's worktrees reads the faces from that peer, the web
// client included. The reads are served to any account peer. The
// commands are gated on the command-access switch like every other
// settings change.
// Starting and cancelling move nothing a viewer caches (the status is
// polled while a download runs), so they skip the cache ping. Removing
// takes the faces away, so it pings.
export const villagersContract = defineContract("host", {
  status: invoke("villagers:status", z.void(), VillagerDataStatusSchema, {
    remote: true,
    gated: false,
  }),
  // Answers with the status once the download is under way (or with
  // ready when there is nothing to do), not when it ends.
  download: invoke("villagers:download", z.void(), VillagerDataStatusSchema, {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  cancel: invoke("villagers:cancel", z.void(), VillagerDataStatusSchema, {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  remove: invoke("villagers:remove", z.void(), VillagerDataStatusSchema, {
    remote: true,
    gated: true,
  }),
  // A face as base64 PNG, or null for a slug without one here.
  face: invoke(
    "villagers:face",
    z.object({ slug: VillagerSlugSchema }),
    z.string().min(1).nullable(),
    { remote: true, gated: false },
  ),
  // Every villager's profile, or null until the data is downloaded.
  profiles: invoke(
    "villagers:profiles",
    z.void(),
    VillagerProfilesSchema.nullable(),
    { remote: true, gated: false },
  ),
});
