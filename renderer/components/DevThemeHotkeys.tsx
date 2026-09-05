import { useEffect } from "react";
import { isEditableTarget, isRawKeySurface } from "@/lib/dom";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";

// Dev-only hotkeys for flipping through the four visual modes without
// opening Settings:
//   Ctrl+T  toggle light/dark
//   Ctrl+D  toggle doubutsu
//   Ctrl+R  drop both previews back to the saved appearance
// They stage the same non-persisted overrides the Settings page uses,
// so nothing is written to config.json; a window reload also resets.
// Bare Ctrl (not Cmd) keeps clear of the real menu accelerators.
// e.code keeps the physical key stable across keyboard layouts.
//
// The listener runs in the capture phase so it can claim a key before a
// raw-key surface (the script console's terminal) does: there Ctrl+D is
// EOF, which dev servers (vite, electron-forge) read as "terminal
// closed" and exit on, so a theme toggle typed into a focused console
// would silently take the run down.
export function DevThemeHotkeys() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  const { resolved, setOverride: setTheme } = useTheme();
  const { applied: doubutsuApplied, setOverride: setDoubutsu } = useDoubutsu();

  useEffect(() => {
    if (!isDev) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) {
        return;
      }
      // Ctrl+T/D/R are Emacs-style edit bindings inside macOS text
      // fields (transpose, delete-forward, ...) — let those win. Raw-key
      // surfaces are the exception (see above).
      const rawSurface = isRawKeySurface(e.target);
      if (isEditableTarget(e.target) && !rawSurface) return;
      let action: (() => void) | null = null;
      if (e.code === "KeyT") {
        action = () => setTheme(resolved === "dark" ? "light" : "dark");
      } else if (e.code === "KeyD") {
        action = () => setDoubutsu(!doubutsuApplied);
      } else if (e.code === "KeyR") {
        action = () => {
          setTheme(null);
          setDoubutsu(null);
        };
      }
      if (!action) return;
      e.preventDefault();
      // Only a raw-key surface would otherwise pass the key on to a
      // program; everywhere else the event may keep bubbling.
      if (rawSurface) e.stopPropagation();
      action();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isDev, resolved, doubutsuApplied, setTheme, setDoubutsu]);

  return null;
}
