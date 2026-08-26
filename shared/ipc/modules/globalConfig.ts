import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ReadGlobalConfigSchema,
  StoredGlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = defineContract("host", {
  // Output is the REDACTED read schema: socketHost.token is structurally
  // absent from the read contract (a derived tokenSet boolean stands in
  // for it), so the secret can never ride out on a read, remote or local.
  read: invoke("globalConfig:read", z.void(), ReadGlobalConfigSchema, {
    remote: true,
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
  // write is remote false: config writes stay local so a remote peer
  // cannot flip hosting settings or the token.
  write: invoke(
    "globalConfig:write",
    WriteGlobalConfigPayloadSchema,
    z.void(),
    {
      remote: false,
    },
  ),
});
