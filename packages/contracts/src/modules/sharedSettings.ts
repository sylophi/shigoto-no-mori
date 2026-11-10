import {
  push,
  defineContract,
  invoke,
  view,
  gatedBy,
  ungated,
} from "../contract.ts";
import {
  MergeSharedSettingsPayloadSchema,
  SetSharedSettingPayloadSchema,
  SharedSettingsDocSchema,
  VoidSchema,
} from "../schemas/index.ts";

// One device's copy of the shared settings
// (schemas/sharedSettings.ts). Host-scoped because the copy
// lives in the device's data dir and its peers read it, though a
// browser serves the same contract off localStorage
// (web/ipc/localRegistrar.ts) so the renderer treats every copy alike.
export const sharedSettingsContract = defineContract(
  "sharedSettings",
  { scope: "host", version: 1 },
  // Served to any account peer: a copy is only useful if the others
  // can read it, and it holds nothing a project list does not already
  // say.
  invoke("read", VoidSchema, SharedSettingsDocSchema, ungated),
  view("watch", VoidSchema, SharedSettingsDocSchema, ungated),
  // A write made at this device: the handler stamps it, so the stamp
  // and the device id are never the caller's to claim. Local only. A
  // peer's write arrives as an already-stamped entry through merge.
  invoke("set", SetSharedSettingPayloadSchema, SharedSettingsDocSchema, {
    remote: false,
    gated: true,
  }),
  // Folds another copy's entries into this one and answers the result.
  // Mutating, so a peer needs the command grant to push. A device that
  // grants none still converges, because its own window pulls (reads a
  // peer, merges here over the local wire). `changed` below is the
  // signal.
  invoke(
    "merge",
    MergeSharedSettingsPayloadSchema,
    SharedSettingsDocSchema,
    gatedBy("changeApp"),
  ),
  // This copy moved, carrying it whole. Fired after every commit to the
  // shared settings, by any writer. A set or a merge that changes
  // nothing commits nothing, which is what ends the exchange: a peer
  // that merges this and learns nothing announces nothing back.
  push("changed", SharedSettingsDocSchema, {
    remote: true,
  }),
);
