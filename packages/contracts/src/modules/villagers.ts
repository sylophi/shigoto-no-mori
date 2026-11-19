import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import {
  VillagerDataStatusSchema,
  VillagerProfilesSchema,
  VillagerSlugSchema,
  VoidSchema,
} from "../schemas/index.ts";

// The villager data, downloaded to and served from this device's data
// dir (host/lib/VillagerData.ts) for Village life, a setting of the
// desktop window (Settings, Appearance). Local only: no peer reads or
// manages another device's copy, and a web client, which has no device
// of its own, offers no Village life.
export const villagersContract = defineContract(
  "villagers",
  { scope: "host", remote: false },
  invoke("status", VoidSchema, VillagerDataStatusSchema),
  // Answers with the status once the download is under way (or with
  // ready when there is nothing to do), not when it ends.
  invoke("download", VoidSchema, VillagerDataStatusSchema),
  invoke("cancel", VoidSchema, VillagerDataStatusSchema),
  invoke("remove", VoidSchema, VillagerDataStatusSchema),
  // A face as base64 PNG, or null for a slug without one here.
  invoke(
    "face",
    Schema.Struct({ slug: VillagerSlugSchema }),
    Schema.NullOr(Schema.NonEmptyString),
  ),
  // Every villager's profile, or null until the data is downloaded.
  invoke("profiles", VoidSchema, Schema.NullOr(VillagerProfilesSchema)),
);
