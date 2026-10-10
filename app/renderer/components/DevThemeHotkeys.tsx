import { useEffect } from "react";
import { isEditableTarget, isRawKeySurface } from "@/lib/dom";
import { usePalette } from "@/hooks/ui/usePalette";
import { useTheme } from "@/hooks/ui/useTheme";
import { DARK_THEMES, LIGHT_THEMES } from "@shigomori/ui/lib/themes.ts";

// The swatches' own palettes, leaving hidden variants to their hotkey.
const DARK_CYCLE = DARK_THEMES.map((option) => option.id);
const LIGHT_CYCLE = LIGHT_THEMES.map((option) => option.id);

// Dev-only hotkeys for flipping through the visual modes without
// opening Settings:
//   Ctrl+T  toggle light/dark
//   Ctrl+D  toggle doubutsu
//   Ctrl+P  cycle the current appearance's doubutsu palette (and turn
//           doubutsu on, so the cycle always shows)
//   Ctrl+R  drop every preview back to the saved appearance
// They stage the same non-persisted overrides the Settings page uses,
// so nothing is written to clientConfig.json, and a window reload also
// resets. Bare Ctrl (not Cmd) keeps clear of the real menu accelerators.
// e.code keeps the physical key stable across keyboard layouts.
//
// The listener runs in the capture phase so it can claim a key before a
// raw-key surface (the script console's terminal) does: there Ctrl+D is
// EOF, which dev servers (vite, electron-forge) read as "terminal
// closed" and exit on, so a theme toggle typed into a focused console
// would silently take the run down.
export function DevThemeHotkeys() {
  // A client fact off the preload bridge, not runtime.info: the hotkeys
  // must key off this build, never the host it talks to.
  const isDev = window.api.isDev;
  const { resolved, setOverride: setTheme } = useTheme();
  // The three primitives, not the picks object: a fresh object each
  // render would re-subscribe the listener on every one.
  const {
    applied: { doubutsu, light, dark },
    setOverride: setPalette,
  } = usePalette();

  useEffect(() => {
    if (!isDev) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat) {
        return;
      }
      // Ctrl+T/D/P/R are Emacs-style edit bindings inside macOS text
      // fields (transpose, delete-forward, previous line, ...), so
      // those win. Raw-key surfaces are the exception (see above).
      const rawSurface = isRawKeySurface(e.target);
      if (isEditableTarget(e.target) && !rawSurface) return;
      if (!["KeyT", "KeyD", "KeyP", "KeyR"].includes(e.code)) return;
      // Ctrl+P is a shell's previous-history key, worth more in the
      // console than a palette preview: there it goes to the program.
      if (e.code === "KeyP" && rawSurface) return;
      e.preventDefault();
      // Only a raw-key surface would otherwise pass the key on to a
      // program. Everywhere else the event may keep bubbling.
      if (rawSurface) e.stopPropagation();
      if (e.code === "KeyT") {
        setTheme(resolved === "dark" ? "light" : "dark");
      } else if (e.code === "KeyD") {
        setPalette({ doubutsu: !doubutsu });
      } else if (e.code === "KeyP") {
        if (resolved === "dark") {
          const i = DARK_CYCLE.indexOf(dark);
          setPalette({
            doubutsu: true,
            dark: DARK_CYCLE[(i + 1) % DARK_CYCLE.length],
          });
        } else {
          const i = LIGHT_CYCLE.indexOf(light);
          setPalette({
            doubutsu: true,
            light: LIGHT_CYCLE[(i + 1) % LIGHT_CYCLE.length],
          });
        }
      } else {
        setTheme(null);
        setPalette(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isDev, resolved, doubutsu, light, dark, setTheme, setPalette]);

  return null;
}
