import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  ReadGlobalConfigSchema,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";

export const globalConfigContract = defineContract("host", {
  // Output is the REDACTED read schema: socketHost.token is structurally
  // absent from the read contract (a derived tokenSet boolean stands in
  // for it), so the secret can never ride out on a read, remote or local.
  read: invoke("globalConfig:read", z.void(), ReadGlobalConfigSchema, {
    remote: true,
  }),
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
