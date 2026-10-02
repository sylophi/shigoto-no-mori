import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  VillagerDataStatusSchema,
  VillagerProfilesSchema,
  VillagerSlugSchema,
} from "@shared/schemas";

// The villager data, downloaded to and served from this device's data
// dir (host/lib/villagers.ts) for Village life, a setting of the
// desktop window (Settings, Appearance). Local only: no peer reads or
// manages another device's copy, and a web client, which has no device
// of its own, offers no Village life.
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
});
