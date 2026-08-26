import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ReadGlobalConfigSchema,
  StoredGlobalConfigSchema,
  WriteDeviceSettingsPayloadSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = defineContract("host", {
  // Output is the REDACTED read schema: socketHost.token is structurally
  // absent from the read contract (a derived tokenSet boolean stands in
  // for it), so the secret can never ride out on a read, remote or local.
  read: invoke("globalConfig:read", z.void(), ReadGlobalConfigSchema, {
    remote: true,
    mutating: false,
  }),
  // The local unredacted path. Output is the FULL stored document,
  // including remoteDevices and the real socketHost.token. It is remote
  // false so a peer can never call it (register.ts only binds remote
  // true channels to the socket), which is what lets the outbound
  // device tokens and the hosting token ride out to the renderer here
  // while staying absent from every wire a remote machine can reach.
  // The renderer's device registry reconciles from this call, and the
  // hosting and remote-device settings sections read their base document
  // from it so a whole-document write never drops the secrets the
  // redacted read omits.
  readLocal: invoke(
    "globalConfig:readLocal",
    z.void(),
    StoredGlobalConfigSchema,
    {
      remote: false,
    },
  ),
  // write is remote false: the WHOLE-document write stays local so a
  // remote peer can never flip hosting settings, the token or the
  // outbound device list. The remote surface gets writeDeviceSettings
  // below instead, whose input schema structurally cannot carry those
  // keys.
  write: invoke(
    "globalConfig:write",
    WriteGlobalConfigPayloadSchema,
    z.void(),
    {
      remote: false,
    },
  ),
  // The remote-writable subset (v2 step 6, slice B): a patch-style
  // write of exactly the device-scoped settings the Settings form
  // manages. remote:true, mutating:true, so it only ever runs for a
  // peer this host granted command access. The STRICT patch schema
  // (DeviceSettingsPatchSchema) rejects unknown keys outright, so
  // socketHost and remoteDevices are structurally unreachable from this
  // channel no matter who calls it. Only provided keys change. The host
  // handler spreads them over the unredacted local document and writes
  // through the same CLI path as `write`, so listener reconciliation
  // still runs.
  writeDeviceSettings: invoke(
    "globalConfig:writeDeviceSettings",
    WriteDeviceSettingsPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
});
