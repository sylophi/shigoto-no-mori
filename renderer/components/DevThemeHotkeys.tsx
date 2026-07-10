import { useEffect } from "react";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";
import { toast } from "@/lib/toast";

// The four visual modes, in cycle order: both doubutsu looks first,
// then both plain looks.
const MODES = [
  { theme: "light", doubutsu: true },
  { theme: "dark", doubutsu: true },
  { theme: "light", doubutsu: false },
  { theme: "dark", doubutsu: false },
] as const;

// Dev-only: Ctrl+Alt+T cycles through all four visual modes
// (light/dark × doubutsu/plain). It stages the same non-persisted
// overrides the Settings page uses, so nothing is written to
// config.json and a window reload snaps back to the saved appearance.
// Ctrl+Alt (not Cmd) keeps clear of the real menu accelerators, and
// e.code keeps the physical key stable across keyboard layouts.
export function DevThemeHotkeys() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  const { resolved, setOverride: setTheme } = useTheme();
  const { applied: doubutsuApplied, setOverride: setDoubutsu } = useDoubutsu();

  useEffect(() => {
    if (!isDev) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.code !== "KeyT" ||
        !e.ctrlKey ||
        !e.altKey ||
        e.metaKey ||
        e.shiftKey ||
        e.repeat
      ) {
        return;
      }
      e.preventDefault();
      const current = MODES.findIndex(
        (m) => m.theme === resolved && m.doubutsu === doubutsuApplied,
      );
      const next = MODES[(current + 1) % MODES.length];
      setTheme(next.theme);
      setDoubutsu(next.doubutsu);
      toast(
        `Preview: ${next.theme} · ${next.doubutsu ? "doubutsu" : "plain"}`,
        {
          id: "dev-theme-hotkeys",
        },
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDev, resolved, doubutsuApplied, setTheme, setDoubutsu]);

  return null;
}
