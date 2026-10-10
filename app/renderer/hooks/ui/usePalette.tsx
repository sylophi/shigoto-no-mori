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

interface PaletteState {
  // Persisted values from clientConfig.json: what Settings considers
  // "saved".
  saved: DoubutsuPicks;
  // Live values, `override` over `saved` field by field. What <html>
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

export function PaletteProvider({ children }: { children: ReactNode }) {
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
  // staged keeps the dark one, so the form and <html> agree until Save.
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
    const html = document.documentElement;
    html.classList.toggle("doubutsu", applied.doubutsu);
    if (active) html.dataset.palette = active;
    else delete html.dataset.palette;
  }, [applied.doubutsu, active]);

  // Mirror the saved values into localStorage so the next launch can
  // paint without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading) return;
    writeStored(STORAGE_KEYS.doubutsu, saved.doubutsu ? "true" : "false");
    writeStored(STORAGE_KEYS.light, saved.light);
    writeStored(STORAGE_KEYS.dark, saved.dark);
  }, [isLoading, saved.doubutsu, saved.light, saved.dark]);

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
