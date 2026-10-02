import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  VillagerDataStatusSchema,
  VillagerProfilesSchema,
  VillagerSlugSchema,
  VisitorTallySchema,
} from "@shared/schemas";

// The villager data, downloaded to and served from this device's data
// dir (host/lib/villagers.ts) for Village life, a setting of the
// desktop window (Settings, Appearance). Local only: no peer reads or
// manages another device's copy, and a web client, which has no device
// of its own, offers no Village life. The one exception is who has
// visited (cli/visitors.go), which Settings' Visitors section reads
// off every device and adds up.
export const villagersContract = defineContract("host", {
  status: invoke("villagers:status", z.void(), VillagerDataStatusSchema, {
    remote: false,
  }),
  // Answers with the status once the download is under way (or with
  // ready when there is nothing to do), not when it ends.
  download: invoke("villagers:download", z.void(), VillagerDataStatusSchema, {
    remote: false,
  }),
  cancel: invoke("villagers:cancel", z.void(), VillagerDataStatusSchema, {
    remote: false,
  }),
  remove: invoke("villagers:remove", z.void(), VillagerDataStatusSchema, {
    remote: false,
  }),
  // A face as base64 PNG, or null for a slug without one here.
  face: invoke(
    "villagers:face",
    z.object({ slug: VillagerSlugSchema }),
    z.string().min(1).nullable(),
    { remote: false },
  ),
  // Every villager's profile, or null until the data is downloaded.
  profiles: invoke(
    "villagers:profiles",
    z.void(),
    VillagerProfilesSchema.nullable(),
    { remote: false },
  ),
  // The villagers who have visited this device, by slug. A read of the
  // same names the worktree lists already show a peer.
  visits: invoke("villagers:visits", z.void(), VisitorTallySchema, {
    remote: true,
    gated: false,
  }),
});
