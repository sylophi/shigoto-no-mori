import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { PreviewThemePayloadSchema } from "@shared/schemas";

// The this-window / app-instance surface: focus signals from the
// BrowserWindow, plus the calls that act on the window's own process.
export const windowContract = defineContract("client", {
  focused: broadcast("window:focused", z.void()),
  blurred: broadcast("window:blurred", z.void()),
  // Non-persisting theme preview for unsaved Settings staging and the
  // dev hotkeys. It drives nativeTheme only, so a reload snaps back to
  // the saved value. Saves land through the clientConfig module.
  previewTheme: invoke(
    "window:previewTheme",
    PreviewThemePayloadSchema,
    z.void(),
  ),
  // Renderer-acknowledged restart after a successful moveRoot: firing
  // this only after the moveRoot reply resolves guarantees the reply
  // was delivered before the app quits. No timing guesses.
  relaunch: invoke("window:relaunch", z.void(), z.void()),
});
