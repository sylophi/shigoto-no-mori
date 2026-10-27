import { safelyInstallRDTHook } from "bippy";
import type { ReactGrabAPI } from "react-grab/core";

// React's devtools hook, which React registers with as it loads: React
// Grab, loaded later, reads the page's components through it. So this
// module is the first an entry imports.
safelyInstallRDTHook();

// ⌘⇧G or Ctrl+Shift+G turns React Grab on or off in the desktop window
// and the web client: a picked element is copied with its components
// and their source files, for an agent working on this repo. It is
// hidden, so it stays outside the keymap (lib/keymap.ts). Its own key
// (⌘C) is off, so a copy stays a copy, and so is its version check.
let grab: Promise<ReactGrabAPI> | null = null;

function toggleGrab() {
  grab ??= import("react-grab/core").then(({ init }) => {
    const api = init({ telemetry: false, activationKey: () => false });
    api.registerPlugin({
      name: "shigomori",
      theme: { toolbar: { enabled: false } },
    });
    return api;
  });
  void grab.then((api) => api.toggle());
}

export function listenForReactGrab(): void {
  // Capture, so a focused terminal doesn't take the keys first.
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        e.code !== "KeyG" ||
        !(e.metaKey || e.ctrlKey) ||
        !e.shiftKey ||
        e.altKey ||
        e.repeat
      ) {
        return;
      }
      e.preventDefault();
      toggleGrab();
    },
    true,
  );
}
