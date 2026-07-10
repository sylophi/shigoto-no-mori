import { useEffect } from "react";
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
// Bare Ctrl (not Cmd) keeps clear of the real menu accelerators on
// macOS; on Windows dev builds the menu's reload accelerator may claim
// Ctrl+R first, which is fine -- a reload also resets the previews.
// e.code keeps the physical key stable across keyboard layouts.
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
      // fields (transpose, delete-forward, ...) — let those win.
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
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
