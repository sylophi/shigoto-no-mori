import { Schema } from "effect";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  MergeSharedSettingsPayloadSchema,
  SetSharedSettingPayloadSchema,
  SharedSettingsDocSchema,
} from "@shared/schemas";

// One device's copy of the shared settings
// (shared/schemas/sharedSettings.ts). Host-scoped because the copy
// lives in the device's data dir and its peers read it, though a
// browser serves the same contract off localStorage
// (web/ipc/register.ts) so the renderer treats every copy alike.
export const sharedSettingsContract = defineContract("host", {
  // Served to any account peer: a copy is only useful if the others
  // can read it, and it holds nothing a project list does not already
  // say.
  read: invoke(
    "sharedSettings:read",
    Schema.Undefined,
    SharedSettingsDocSchema,
    {
      remote: true,
      mutating: false,
    },
  ),
  // A write made at this device: the handler stamps it, so the stamp
  // and the device id are never the caller's to claim. Local only. A
  // peer's write arrives as an already-stamped entry through merge.
  set: invoke(
    "sharedSettings:set",
    SetSharedSettingPayloadSchema,
    SharedSettingsDocSchema,
    { remote: false, mutating: true, movesHostState: false },
  ),
  // Folds another copy's entries into this one and answers the result.
  // Mutating, so a peer needs the command grant to push. A device that
  // grants none still converges, because its own window pulls (reads a
  // peer, merges here over the local wire). movesHostState false on
  // both writers: `changed` below is the precise signal, and the broad
  // viewer ping would refetch a peer's whole forest over a preference.
  merge: invoke(
    "sharedSettings:merge",
    MergeSharedSettingsPayloadSchema,
    SharedSettingsDocSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  // This copy moved, carrying it whole. Fired only when a set or a
  // merge actually changed something, which is what ends the exchange:
  // a peer that merges this and learns nothing announces nothing back.
  changed: broadcast("sharedSettings:changed", SharedSettingsDocSchema, {
    remote: true,
  }),
});
