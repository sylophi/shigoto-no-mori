import { useEffect } from "react";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useDoubutsu } from "@/hooks/ui/useDoubutsu";
import { useTheme } from "@/hooks/ui/useTheme";
import { toast } from "@/lib/toast";

// Dev-only hotkeys for flipping through the four visual modes without
// opening Settings:
//   Ctrl+Alt+T  toggle light/dark
//   Ctrl+Alt+D  toggle doubutsu
//   Ctrl+Alt+R  drop both previews back to the saved appearance
// They stage the same non-persisted overrides the Settings page uses,
// so nothing is written to config.json; a window reload also resets.
// Ctrl+Alt (not Cmd) keeps clear of the real menu accelerators, and
// e.code keeps the physical key stable across keyboard layouts.
export function DevThemeHotkeys() {
  const { data: runtime } = useRuntimeInfo();
  const isDev = runtime?.isDev ?? false;
  const { resolved, setOverride: setTheme } = useTheme();
  const { applied: doubutsuApplied, setOverride: setDoubutsu } = useDoubutsu();

  useEffect(() => {
    if (!isDev) return;
    const describe = (theme: string, doubutsu: boolean) =>
      `Preview: ${theme} · ${doubutsu ? "doubutsu" : "plain"}`;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || e.repeat) {
        return;
      }
      if (e.code === "KeyT") {
        e.preventDefault();
        const next = resolved === "dark" ? "light" : "dark";
        setTheme(next);
        toast(describe(next, doubutsuApplied), { id: "dev-theme-hotkeys" });
      } else if (e.code === "KeyD") {
        e.preventDefault();
        const next = !doubutsuApplied;
        setDoubutsu(next);
        toast(describe(resolved, next), { id: "dev-theme-hotkeys" });
      } else if (e.code === "KeyR") {
        e.preventDefault();
        setTheme(null);
        setDoubutsu(null);
        toast("Preview cleared — back to saved appearance", {
          id: "dev-theme-hotkeys",
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDev, resolved, doubutsuApplied, setTheme, setDoubutsu]);

  return null;
}
