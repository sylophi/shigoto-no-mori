import { defineContract, invoke, view } from "../contract.ts";
import {
  StoredGlobalConfigSchema,
  VoidSchema,
  WriteDeviceSettingsPayloadSchema,
} from "../schemas/index.ts";

export const globalConfigContract = defineContract(
  "globalConfig",
  "host",
  // The stored document, loose so legacy and newer keys pass through.
  // It carries no secret, so every wire serves it ungated.
  invoke("read", VoidSchema, StoredGlobalConfigSchema, {
    remote: true,
    gated: false,
  }),
  view("watch", VoidSchema, StoredGlobalConfigSchema, {
    remote: true,
    gated: false,
  }),
  // The one settings write, for this window's own device and for a
  // peer's: a patch of exactly the device-scoped settings the Settings
  // form manages. remote:true, gated:true, so over the direct wire
  // it only ever runs for a peer while this host accepts commands. The
  // STRICT patch schema (DeviceSettingsPatchSchema) rejects unknown keys
  // outright, so nothing the form does not manage is reachable from
  // this channel no matter who calls it. Only provided keys change. The
  // host handler applies them over the stored document and writes it
  // through the CLI, whose cache invalidation reconciles the listeners.
  invoke("writeDeviceSettings", WriteDeviceSettingsPayloadSchema, VoidSchema, {
    remote: true,
    gated: true,
    grant: "changeApp",
  }),
);
