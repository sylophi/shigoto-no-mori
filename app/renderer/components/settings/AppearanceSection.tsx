import type { Theme, ThemeRotation } from "@shigomori/contracts/schemas";
import {
  DARK_THEMES,
  type DarkTheme,
  LIGHT_THEMES,
  type LightTheme,
} from "@shigomori/ui/lib/themes.ts";
import { batterySupported } from "@/hooks/ui/usePauseAnimationsOnBattery";
import { usePhoneLayout } from "@/hooks/ui/useViewport";
import { useHasLocalHost } from "@/lib/localHost";
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
  themeRotation: boolean;
  onThemeRotationChange: (next: boolean) => void;
  themeRotationEvery: ThemeRotation;
  onThemeRotationEveryChange: (next: ThemeRotation) => void;
  pauseAnimationsOnBattery: boolean;
  onPauseAnimationsOnBatteryChange: (next: boolean) => void;
  darkTerminals: boolean;
  onDarkTerminalsChange: (next: boolean) => void;
  terminalFontSize: number | undefined;
  onTerminalFontSizeChange: (next: number | undefined) => void;
  villageLife: boolean;
  onVillageLifeChange: (next: boolean) => void;
  villageNews: boolean;
  onVillageNewsChange: (next: boolean) => void;
}) {
  const hasLocalHost = useHasLocalHost();
  const phone = usePhoneLayout();
  return (
    <AppearanceSectionView
      {...props}
      // The type scale's text-xs, the terminals' own (phone.css).
      defaultTerminalFontSize={phone ? 14 : 12}
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
