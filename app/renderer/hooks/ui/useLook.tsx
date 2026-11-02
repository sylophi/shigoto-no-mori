import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  clientSetting,
  type ClientConfig,
  type Theme,
} from "@shigomori/contracts/schemas/config";
import {
  activeTheme,
  type DarkTheme,
  type DoubutsuPicks,
  type LightTheme,
  resolveDoubutsuPicks,
} from "@shigomori/ui/lib/themes.ts";
import { watchTheme } from "@shigomori/ui/root.tsx";
import { useClientConfig } from "../config/useClientConfig";
import { usePauseAnimationsOnBattery } from "./usePauseAnimationsOnBattery";
import { readStored, writeStored } from "@/lib/localStorage";
import { useWindowRoot } from "@/lib/themeRoot";
import { useApi } from "@/lib/runtime/pageApi";

// The window's appearance setting and its doubutsu picks.
export interface Look extends DoubutsuPicks {
  theme: Theme;
}

interface LookState {
  // Persisted values from clientConfig.json: what Settings considers
  // "saved".
  saved: Look;
  // Live values, `override` over `saved` field by field. What the root
  // wears follows from them: the `dark` class and the BrowserWindow
  // background from the theme, the `.doubutsu` class from the switch,
  // `data-palette` from the resolved appearance's pick.
  applied: Look;
  resolved: "light" | "dark";
  // Settings calls this to stage a preview of any field, merged over
  // the fields already staged. Passing null clears every override and
  // snaps back to whatever is currently saved.
  setOverride: (next: Partial<Look> | null) => void;
}

const LookContext = createContext<LookState | null>(null);
// The localStorage mirrors the boot script reads
// (web/public/boot-theme.js): the theme, the switch, and a pick per
// appearance.
const STORAGE_KEYS = {
  theme: "shigomori.theme",
  doubutsu: "shigomori.doubutsu",
  light: "shigomori.lightTheme",
  dark: "shigomori.darkTheme",
} as const;

function lookOf(config: ClientConfig): Look {
  return {
    theme: clientSetting(config, "theme"),
    ...resolveDoubutsuPicks(config),
  };
}

function readBootHint(): Look {
  const theme = readStored(STORAGE_KEYS.theme);
  return {
    theme:
      theme === "light" || theme === "dark" || theme === "system"
        ? theme
        : "system",
    // Default is ON: only an explicit "false" (a saved opt-out) disables
    // the first paint's doubutsu look. The stored picks are the mirror's
    // own writes, so an unknown one can only be a newer build's:
    // resolveDoubutsuPicks keeps it, and the stylesheet falls back to
    // the default block for it.
    ...resolveDoubutsuPicks({
      doubutsu: readStored(STORAGE_KEYS.doubutsu) !== "false",
      lightTheme:
        (readStored(STORAGE_KEYS.light) as LightTheme | null) ?? undefined,
      darkTheme:
        (readStored(STORAGE_KEYS.dark) as DarkTheme | null) ?? undefined,
    }),
  };
}

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// The theme the root wears, kept in step as whoever owns it switches
// it.
function useRootTheme(root: HTMLElement): "light" | "dark" {
  return useSyncExternalStore(
    (onChange) => watchTheme(root, onChange),
    () => (root.classList.contains("dark") ? "dark" : "light"),
  );
}

export function LookProvider({
  fromRoot,
  children,
}: {
  // The window's look is its root's, set by the page around it (a
  // frame on the marketing site), rather than the settings'. The
  // settings still read and save as usual, but don't reach the root.
  fromRoot: boolean;
  children: ReactNode;
}) {
  const api = useApi();
  const root = useWindowRoot();
  const rootTheme = useRootTheme(root);
  const { data: config, isLoading } = useClientConfig();
  // Avoid a one-frame flash of the wrong look while clientConfig
  // fetches by trusting the localStorage mirror. Read live at
  // evaluation time, not captured at mount: a later cache clear (nuke)
  // must fall back to the current mirror, not flash the launch-time
  // value. Config wins as soon as it arrives.
  const saved: Look = isLoading ? readBootHint() : lookOf(config ?? {});
  const [override, setOverrideState] = useState<Partial<Look> | null>(null);
  // A field at a time: a light pick staged while a dark pick is already
  // staged keeps the dark one, so the form and the root agree until Save.
  const setOverride = (next: Partial<Look> | null) => {
    setOverrideState((prev) => (next === null ? null : { ...prev, ...next }));
  };
  const applied: Look = {
    theme: override?.theme ?? saved.theme,
    doubutsu: override?.doubutsu ?? saved.doubutsu,
    light: override?.light ?? saved.light,
    dark: override?.dark ?? saved.dark,
  };
  // The wallpaper this pauses is doubutsu's, so the pause lives here.
  usePauseAnimationsOnBattery();

  // Once a save lands and `saved` catches up to the staged override,
  // drop the override so future updates to `saved` flow.
  // Adjusted during render (not in an effect) so no committed frame holds
  // the stale pair, and `applied` is identical either way.
  if (
    override !== null &&
    applied.theme === saved.theme &&
    applied.doubutsu === saved.doubutsu &&
    applied.light === saved.light &&
    applied.dark === saved.dark
  ) {
    setOverrideState(null);
  }

  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    getSystemTheme(),
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const resolved = fromRoot
    ? rootTheme
    : applied.theme === "system"
      ? systemTheme
      : applied.theme;
  const active = activeTheme(applied, resolved);

  // Before paint, so a saved look that differs from the boot mirror's
  // (a launch's palette rotation, lib/themeRotation.ts) never shows a
  // frame of the mirror's. color-scheme too, which the boot script sets
  // once: native controls (scrollbars, media players) follow it, not
  // the class.
  useLayoutEffect(() => {
    if (fromRoot) return;
    root.classList.toggle("dark", resolved === "dark");
    root.style.setProperty("color-scheme", resolved);
    root.classList.toggle("doubutsu", applied.doubutsu);
    if (active) root.setAttribute("data-palette", active);
    else root.removeAttribute("data-palette");
  }, [fromRoot, root, resolved, applied.doubutsu, active]);

  // Keep the main process in sync so the BrowserWindow background tracks
  // the applied theme (including unsaved previews). Non-persisting: the
  // saved value lands through the clientConfig patch instead.
  useEffect(() => {
    if (!fromRoot)
      void api.run(api.window.previewTheme({ theme: applied.theme }));
  }, [fromRoot, applied.theme, api]);

  // Mirror the saved values into localStorage so the next launch can
  // paint without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading || fromRoot) return;
    writeStored(STORAGE_KEYS.theme, saved.theme);
    writeStored(STORAGE_KEYS.doubutsu, saved.doubutsu ? "true" : "false");
    writeStored(STORAGE_KEYS.light, saved.light);
    writeStored(STORAGE_KEYS.dark, saved.dark);
  }, [
    isLoading,
    fromRoot,
    saved.theme,
    saved.doubutsu,
    saved.light,
    saved.dark,
  ]);

  return (
    <LookContext value={{ saved, applied, resolved, setOverride }}>
      {children}
    </LookContext>
  );
}

export function useLook(): LookState {
  const ctx = use(LookContext);
  if (!ctx) {
    throw new Error("useLook must be used inside LookProvider");
  }
  return ctx;
}
