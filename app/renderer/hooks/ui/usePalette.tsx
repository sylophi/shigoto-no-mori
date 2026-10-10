import { createContext, use, useEffect, useState, type ReactNode } from "react";
import {
  activeTheme,
  type DarkTheme,
  type DoubutsuPicks,
  type LightTheme,
  resolveDoubutsuPicks,
} from "@shigomori/ui/lib/themes.ts";
import { useClientConfig } from "../config/useClientConfig";
import { usePauseAnimationsOnBattery } from "./usePauseAnimationsOnBattery";
import { readStored, writeStored } from "@/lib/localStorage";
import { useTheme } from "./useTheme";
import { useWindowRoot } from "@/lib/themeRoot";

interface PaletteState {
  // Persisted values from clientConfig.json: what Settings considers
  // "saved".
  saved: DoubutsuPicks;
  // Live values, `override` over `saved` field by field. What the root
  // wears follows from them: the `.doubutsu` class from the switch,
  // `data-palette` from the resolved appearance's pick.
  applied: DoubutsuPicks;
  // Settings calls this to stage a preview of any field, merged over
  // the fields already staged. Passing null clears every override and
  // snaps back to whatever is currently saved.
  setOverride: (next: Partial<DoubutsuPicks> | null) => void;
}

const PaletteContext = createContext<PaletteState | null>(null);
// The localStorage mirrors the boot scripts read (index.html,
// web/public/boot-theme.js): the switch, and a pick per appearance.
const STORAGE_KEYS = {
  doubutsu: "shigomori.doubutsu",
  light: "shigomori.lightTheme",
  dark: "shigomori.darkTheme",
} as const;

function readBootHint(): DoubutsuPicks {
  // Default is ON: only an explicit "false" (a saved opt-out) disables
  // the first paint's doubutsu look. The stored picks are the mirror's
  // own writes, so an unknown one can only be a newer build's:
  // resolveDoubutsuPicks keeps it, and the stylesheet falls back to
  // the default block for it.
  return resolveDoubutsuPicks({
    doubutsu: readStored(STORAGE_KEYS.doubutsu) !== "false",
    lightTheme:
      (readStored(STORAGE_KEYS.light) as LightTheme | null) ?? undefined,
    darkTheme: (readStored(STORAGE_KEYS.dark) as DarkTheme | null) ?? undefined,
  });
}

export function PaletteProvider({
  fromRoot,
  children,
}: {
  // The root's look is the page's around it (ThemeProvider's fromRoot).
  fromRoot: boolean;
  children: ReactNode;
}) {
  const root = useWindowRoot();
  const { data: config, isLoading } = useClientConfig();
  const { resolved } = useTheme();
  // Avoid a one-frame flash of the wrong look while clientConfig
  // fetches by trusting the localStorage mirror. Read live at
  // evaluation time, not captured at mount: a later cache clear (nuke)
  // must fall back to the current mirror, not flash the launch-time
  // value. Config wins as soon as it arrives.
  const saved: DoubutsuPicks = isLoading
    ? readBootHint()
    : resolveDoubutsuPicks(config ?? {});
  const [override, setOverrideState] = useState<Partial<DoubutsuPicks> | null>(
    null,
  );
  // A field at a time: a light pick staged while a dark pick is already
  // staged keeps the dark one, so the form and the root agree until Save.
  const setOverride = (next: Partial<DoubutsuPicks> | null) => {
    setOverrideState((prev) => (next === null ? null : { ...prev, ...next }));
  };
  const applied: DoubutsuPicks = {
    doubutsu: override?.doubutsu ?? saved.doubutsu,
    light: override?.light ?? saved.light,
    dark: override?.dark ?? saved.dark,
  };
  const active = activeTheme(applied, resolved);
  // The wallpaper this pauses is doubutsu's, so the pause lives here.
  usePauseAnimationsOnBattery();

  // Once a save lands and `saved` catches up to the staged override,
  // drop the override so future updates to `saved` flow.
  // Adjusted during render (not in an effect) so no committed frame holds
  // the stale pair, and `applied` is identical either way.
  if (
    override !== null &&
    (override.doubutsu === undefined || override.doubutsu === saved.doubutsu) &&
    (override.light === undefined || override.light === saved.light) &&
    (override.dark === undefined || override.dark === saved.dark)
  ) {
    setOverrideState(null);
  }

  useEffect(() => {
    if (fromRoot) return;
    root.classList.toggle("doubutsu", applied.doubutsu);
    if (active) root.dataset.palette = active;
    else delete root.dataset.palette;
  }, [fromRoot, root, applied.doubutsu, active]);

  // Mirror the saved values into localStorage so the next launch can
  // paint without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading || fromRoot) return;
    writeStored(STORAGE_KEYS.doubutsu, saved.doubutsu ? "true" : "false");
    writeStored(STORAGE_KEYS.light, saved.light);
    writeStored(STORAGE_KEYS.dark, saved.dark);
  }, [isLoading, fromRoot, saved.doubutsu, saved.light, saved.dark]);

  return (
    <PaletteContext value={{ saved, applied, setOverride }}>
      {children}
    </PaletteContext>
  );
}

export function usePalette(): PaletteState {
  const ctx = use(PaletteContext);
  if (!ctx) {
    throw new Error("usePalette must be used inside PaletteProvider");
  }
  return ctx;
}
