import { Moon, Sun, SunMoon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SectionHeading } from "@/components/ui/section-heading";
import type { Theme } from "@shared/schemas";
import {
  DARK_THEMES,
  type DarkTheme,
  LIGHT_THEMES,
  type LightTheme,
  type ThemeOption,
} from "@shared/themes";
import { ToggleRow } from "@/components/shared/ToggleRow";
import { batterySupported } from "@/hooks/ui/usePauseAnimationsOnBattery";
import { hasLocalHost } from "@/lib/localHost";
import { cn } from "@/lib/utils";
import { ThemePicker } from "./ThemePicker";
import { VillageLifeSetting } from "./VillageLifeSetting";

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
];

interface AppearanceSectionProps {
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
  // "Appearance" where the section stands alone (the web page). The
  // desktop's Appearance section already says that and names it "Theme".
  heading?: string;
}

export function AppearanceSection({
  theme,
  onPick,
  doubutsu,
  onDoubutsuChange,
  lightTheme,
  onLightThemeChange,
  darkTheme,
  onDarkThemeChange,
  pauseAnimationsOnBattery,
  onPauseAnimationsOnBatteryChange,
  villageLife,
  onVillageLifeChange,
  heading = "Appearance",
}: AppearanceSectionProps) {
  // A three-way pick, so it wears the house segmented control: the
  // chosen option carries the accent fill, the other two stay quiet.
  // Three same-looking chips left the active theme unreadable.
  const options = THEMES.map(({ value, label, Icon }) => ({
    value,
    label: (
      <>
        <Icon className="size-3.5" />
        {label}
      </>
    ),
  }));
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">{heading}</SectionHeading>
      <SegmentedControl
        aria-label="Theme"
        value={theme}
        onChange={onPick}
        options={options}
        optionClassName="px-3 py-1.5 text-xs"
      />
      <ToggleRow
        checked={doubutsu}
        onCheckedChange={onDoubutsuChange}
        label="Doubutsu theme"
        description="Bold, color-blocked Animal Crossing inspired theme. Layers on top of light and dark; turn off for the plain, neutral look."
      />
      {/* Its palettes, one per appearance the way most apps offer it,
          so a cream day and a navy night can go together. They wait,
          greyed, while the switch is off. */}
      <div
        className={cn("space-y-3 pl-11", !doubutsu && "pointer-events-none")}
      >
        <PaletteRow
          label="Light palette"
          appearance="light"
          options={LIGHT_THEMES}
          value={lightTheme}
          onChange={onLightThemeChange}
          disabled={!doubutsu}
        />
        <PaletteRow
          label="Dark palette"
          appearance="dark"
          options={DARK_THEMES}
          value={darkTheme}
          onChange={onDarkThemeChange}
          disabled={!doubutsu}
        />
      </div>
      {/* A browser without the Battery Status API has nothing to pause
          on, and neither does the plain look: the wallpaper is doubutsu's. */}
      {batterySupported && (
        <ToggleRow
          checked={pauseAnimationsOnBattery}
          onCheckedChange={onPauseAnimationsOnBatteryChange}
          disabled={!doubutsu}
          label="Pause always-on animations on battery"
          description="The drifting wallpaper redraws the window every frame, even when nothing else is happening. Pausing it while this machine runs on battery saves energy, and it picks up again when plugged in."
        />
      )}
      {/* Desktop only: the villager data it needs lives in this
          device's data dir. */}
      {hasLocalHost && (
        <VillageLifeSetting
          villageLife={villageLife}
          onChange={onVillageLifeChange}
        />
      )}
    </section>
  );
}

// A labelled palette row under the switch, greyed with it.
function PaletteRow<Id extends LightTheme | DarkTheme>({
  label,
  disabled,
  ...picker
}: {
  label: string;
  appearance: "light" | "dark";
  options: readonly ThemeOption<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <p
        className={cn(
          "text-xs text-muted-foreground",
          disabled && "opacity-50",
        )}
      >
        {label}
      </p>
      <ThemePicker disabled={disabled} {...picker} />
    </div>
  );
}
