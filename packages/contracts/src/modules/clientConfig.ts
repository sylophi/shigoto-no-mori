import { defineContract, invoke } from "../contract.ts";
import {
  StoredClientConfigSchema,
  VoidSchema,
  WriteClientConfigPayloadSchema,
} from "../schemas/index.ts";

// The client config store (theme, palettes) in the app instance's own
// userData. Client-scoped because the store must stay on the machine
// showing the window even once the host goes remote. Same shape as the
// globalConfig module: read/write, loose on the way out, strict on the
// way in.
export const clientConfigContract = defineContract(
  "clientConfig",
  "client",
  invoke("read", VoidSchema, StoredClientConfigSchema),
  // Pure persistence. Applying the theme to the native window chrome is
  // the window module's previewTheme, which the renderer has always
  // fired by the time a save lands.
  invoke("write", WriteClientConfigPayloadSchema, VoidSchema),
);
