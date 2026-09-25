import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  StoredGlobalConfigSchema,
  WriteDeviceSettingsPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = defineContract("host", {
  // The stored document, loose so legacy and newer keys pass through.
  // It carries no secret, so every wire serves it ungated.
  read: invoke("globalConfig:read", z.void(), StoredGlobalConfigSchema, {
    remote: true,
    mutating: false,
  }),
  // The one settings write, for this window's own device and for a
  // peer's: a patch of exactly the device-scoped settings the Settings
  // form manages. remote:true, mutating:true, so over the direct wire
  // it only ever runs for a peer while this host accepts commands. The
  // STRICT patch schema (DeviceSettingsPatchSchema) rejects unknown keys
  // outright, so nothing the form does not manage is reachable from
  // this channel no matter who calls it. Only provided keys change. The
  // host handler applies them over the stored document and writes it
  // through the CLI, whose cache invalidation reconciles the listeners.
  writeDeviceSettings: invoke(
    "globalConfig:writeDeviceSettings",
    WriteDeviceSettingsPayloadSchema,
    z.void(),
    { remote: true, mutating: true },
  ),
});
