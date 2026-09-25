import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import {
  StoredClientConfigSchema,
  WriteClientConfigPayloadSchema,
} from "@shared/schemas";

// The client config store (theme, doubutsu) in the app instance's own
// userData. Client-scoped because the store must stay on the machine
// showing the window even once the host goes remote. Same shape as the
// globalConfig module: read/write, loose on the way out, strict on the
// way in.
export const clientConfigContract = defineContract("client", {
  read: invoke("clientConfig:read", z.void(), StoredClientConfigSchema),
  // Pure persistence. Applying the theme to the native window chrome is
  // the window module's previewTheme, which the renderer has always
  // fired by the time a save lands.
  write: invoke("clientConfig:write", WriteClientConfigPayloadSchema, z.void()),
});
