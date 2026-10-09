import { broadcast, defineContract, invoke } from "../contract.ts";
import {
  NotifyPayloadSchema,
  PreviewThemePayloadSchema,
  VoidSchema,
} from "../schemas/index.ts";

// The this-window / app-instance surface: focus signals from the
// BrowserWindow, plus the calls that act on the window's own process.
export const windowContract = defineContract(
  "window",
  "client",
  broadcast("focused", VoidSchema),
  broadcast("blurred", VoidSchema),
  // Non-persisting theme preview for unsaved Settings staging and the
  // dev hotkeys. It drives nativeTheme only, so a reload snaps back to
  // the saved value. Saves land through the clientConfig module.
  invoke("previewTheme", PreviewThemePayloadSchema, VoidSchema),
  // Renderer-acknowledged restart after a successful moveDataDir: firing
  // this only after the moveDataDir reply resolves guarantees the reply
  // was delivered before the app quits. No timing guesses.
  invoke("relaunch", VoidSchema, VoidSchema),
  // A system notification that opens `route` (a deep link's path) when
  // clicked.
  invoke("notify", NotifyPayloadSchema, VoidSchema),
);
