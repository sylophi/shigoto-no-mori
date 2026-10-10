import type { Theme } from "@shigomori/contracts/schemas";
import {
  DARK_THEMES,
  type DarkTheme,
  LIGHT_THEMES,
  type LightTheme,
} from "@shigomori/ui/lib/themes.ts";
import { batterySupported } from "@/hooks/ui/usePauseAnimationsOnBattery";
import { hasLocalHost } from "@/lib/localHost";
import { AppearanceSectionView } from "@shigomori/ui/views/settings/AppearanceSectionView.tsx";
import { ThemePicker } from "./ThemePicker";
import { VillageLifeSetting } from "./VillageLifeSetting";

// The appearance settings (AppearanceSectionView), with the palette
// picks and village life bound to their own reads.
export function AppearanceSection({
  lightTheme,
  onLightThemeChange,
  darkTheme,
  onDarkThemeChange,
  villageLife,
  onVillageLifeChange,
  villageNews,
  onVillageNewsChange,
  ...props
}: {
  theme: Theme;
  onPick: (theme: Theme) => void;
  doubutsu: boolean;
  onDoubutsuChange: (next: boolean) => void;
  lightTheme: LightTheme;
  onLightThemeChange: (next: LightTheme) => void;
  darkTheme: DarkTheme;
  onDarkThemeChange: (next: DarkTheme) => void;
  pauseAnimationsOnBattery: boolean;
  onPauseAnimationsOnBatteryChange: (next: boolean) => void;
  villageLife: boolean;
  onVillageLifeChange: (next: boolean) => void;
  villageNews: boolean;
  onVillageNewsChange: (next: boolean) => void;
  heading?: string;
}) {
  return (
    <AppearanceSectionView
      {...props}
      battery={batterySupported}
      lightPalette={
        <ThemePicker
          appearance="light"
          options={LIGHT_THEMES}
          value={lightTheme}
          onChange={onLightThemeChange}
          disabled={!props.doubutsu}
        />
      }
      darkPalette={
        <ThemePicker
          appearance="dark"
          options={DARK_THEMES}
          value={darkTheme}
          onChange={onDarkThemeChange}
          disabled={!props.doubutsu}
        />
      }
      // Desktop only: the villager data it needs lives in this device's
      // data dir.
      villageLife={
        hasLocalHost && (
          <VillageLifeSetting
            villageLife={villageLife}
            onVillageLifeChange={onVillageLifeChange}
            villageNews={villageNews}
            onVillageNewsChange={onVillageNewsChange}
          />
        )
      }
    />
  );
}
