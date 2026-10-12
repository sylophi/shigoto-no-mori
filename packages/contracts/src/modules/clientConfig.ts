import { defineContract, invoke, view } from "../contract.ts";
import {
  PatchClientConfigPayloadSchema,
  StoredClientConfigSchema,
  VoidSchema,
} from "../schemas/index.ts";

// The client config store (theme, palettes) in the app instance's own
// userData. Client-scoped because the store must stay on the machine
// showing the window even once the host goes remote. Same shape as the
// globalConfig module: read and a patch, loose on the way out, strict
// on the way in.
export const clientConfigContract = defineContract(
  "clientConfig",
  "client",
  invoke("read", VoidSchema, StoredClientConfigSchema),
  // The same, then again on every write, whichever window made it: every
  // window of this app instance follows one copy.
  view("watch", VoidSchema, StoredClientConfigSchema),
  // Pure persistence. Applying the theme to the native window chrome is
  // the window module's previewTheme, which the renderer has always
  // fired by the time a save lands.
  invoke("patch", PatchClientConfigPayloadSchema, VoidSchema),
);
