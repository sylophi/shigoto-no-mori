import { useEffect } from "react";
import { isEditableTarget } from "@/lib/dom";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";

// Dev-only hotkeys for flipping through the four visual modes without
// opening Settings:
//   Ctrl+T  toggle light/dark
//   Ctrl+D  toggle doubutsu
//   Ctrl+R  drop both previews back to the saved appearance
// They stage the same non-persisted overrides the Settings page uses,
// so nothing is written to clientConfig.json, and a window reload also
// resets. Bare Ctrl (not Cmd) keeps clear of the real menu accelerators.
// e.code keeps the physical key stable across keyboard layouts.
export function DevThemeHotkeys() {
  // A client fact off the preload bridge, not runtime.info: the hotkeys
  // must key off this build, never the host it talks to.
  const isDev = window.api.isDev;
  const { resolved, setOverride: setTheme } = useTheme();
  const { applied: doubutsuApplied, setOverride: setDoubutsu } = useDoubutsu();

  useEffect(() => {
    if (!isDev) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) {
        return;
      }
      // Ctrl+T/D/R are Emacs-style edit bindings inside macOS text
      // fields (transpose, delete-forward, ...) — let those win.
      if (isEditableTarget(e.target)) return;
      if (e.code === "KeyT") {
        e.preventDefault();
        setTheme(resolved === "dark" ? "light" : "dark");
      } else if (e.code === "KeyD") {
        e.preventDefault();
        setDoubutsu(!doubutsuApplied);
      } else if (e.code === "KeyR") {
        e.preventDefault();
        setTheme(null);
        setDoubutsu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDev, resolved, doubutsuApplied, setTheme, setDoubutsu]);

  return null;
}
