import { Schema } from "effect";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { PreviewThemePayloadSchema } from "@shared/schemas";

// The this-window / app-instance surface: focus signals from the
// BrowserWindow, plus the calls that act on the window's own process.
export const windowContract = defineContract("client", {
  focused: broadcast("window:focused", Schema.Undefined),
  blurred: broadcast("window:blurred", Schema.Undefined),
  // Non-persisting theme preview for unsaved Settings staging and the
  // dev hotkeys. It drives nativeTheme only, so a reload snaps back to
  // the saved value. Saves land through the clientConfig module.
  previewTheme: invoke(
    "window:previewTheme",
    PreviewThemePayloadSchema,
    Schema.Undefined,
  ),
  // Renderer-acknowledged restart after a successful moveDataDir: firing
  // this only after the moveDataDir reply resolves guarantees the reply
  // was delivered before the app quits. No timing guesses.
  relaunch: invoke("window:relaunch", Schema.Undefined, Schema.Undefined),
});
