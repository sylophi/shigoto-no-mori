import type { ReactNode } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import type { Theme, ThemeRotation } from "@shigomori/contracts/schemas";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";
import { cn } from "../../lib/utils.ts";

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
];

const TERMINAL_FONT_SIZES = [10, 11, 12, 13, 14, 16, 18];

const ROTATIONS: { value: ThemeRotation; label: string }[] = [
  { value: "launch", label: "Each launch" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export interface AppearanceSectionViewProps {
  theme: Theme;
  onPick: (theme: Theme) => void;
  doubutsu: boolean;
  onDoubutsuChange: (next: boolean) => void;
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
  // What terminals take with no size of their own.
  defaultTerminalFontSize: number;
  // A browser without the Battery Status API has nothing to pause on.
  battery: boolean;
  // The two palette picks (ThemePicker).
  lightPalette: ReactNode;
  darkPalette: ReactNode;
  // Village life, where this window has it.
  villageLife: ReactNode;
}

export function AppearanceSectionView({
  theme,
  onPick,
  doubutsu,
  onDoubutsuChange,
  themeRotation,
  onThemeRotationChange,
  themeRotationEvery,
  onThemeRotationEveryChange,
  pauseAnimationsOnBattery,
  onPauseAnimationsOnBatteryChange,
  darkTerminals,
  onDarkTerminalsChange,
  terminalFontSize,
  onTerminalFontSizeChange,
  defaultTerminalFontSize,
  battery,
  lightPalette,
  darkPalette,
  villageLife,
}: AppearanceSectionViewProps) {
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
      <SectionHeading className="mb-1">Theme</SectionHeading>
      <SegmentedControl
        aria-label="Theme"
        value={theme}
        onChange={onPick}
        options={options}
        optionClassName="px-3 py-1.5 text-xs"
      />
      {/* Doubutsu's palettes, one per appearance the way most apps offer it,
          so a cream day and a navy night can go together. They wait,
          greyed, while Boring mode is on. */}
      <div className={cn("space-y-3", !doubutsu && "pointer-events-none")}>
        <PaletteRow label="Light palette" disabled={!doubutsu}>
          {lightPalette}
        </PaletteRow>
        <PaletteRow label="Dark palette" disabled={!doubutsu}>
          {darkPalette}
        </PaletteRow>
        <ToggleRowView
          checked={themeRotation}
          onCheckedChange={onThemeRotationChange}
          disabled={!doubutsu}
          label="Rotate palettes"
        />
        <div className="pl-11">
          <SegmentedControl
            aria-label="Rotate palettes"
            value={themeRotationEvery}
            onChange={onThemeRotationEveryChange}
            options={ROTATIONS}
            disabled={!doubutsu || !themeRotation}
            optionClassName="px-3 py-1.5 text-xs"
          />
        </div>
      </div>
      <ToggleRowView
        checked={!doubutsu}
        onCheckedChange={(boring) => onDoubutsuChange(!boring)}
        label="Boring mode"
        description="Plain, neutral look without the Doubutsu theme."
      />
      <ToggleRowView
        checked={darkTerminals}
        onCheckedChange={onDarkTerminalsChange}
        label="Always dark terminals"
      />
      <div className="space-y-2">
        <p className="text-sm">Terminal font size</p>
        <SegmentedControl
          aria-label="Terminal font size"
          value={String(terminalFontSize ?? defaultTerminalFontSize)}
          onChange={(next) =>
            onTerminalFontSizeChange(
              Number(next) === defaultTerminalFontSize
                ? undefined
                : Number(next),
            )
          }
          options={TERMINAL_FONT_SIZES.map((px) => ({
            value: String(px),
            label: px === defaultTerminalFontSize ? `${px} (Default)` : px,
          }))}
          optionClassName="px-2.5 py-1.5 text-xs whitespace-nowrap tabular-nums"
        />
      </div>
      {/* A browser without the Battery Status API has nothing to pause
          on, and neither does plain mode: the wallpaper is doubutsu's. */}
      {battery && (
        <ToggleRowView
          checked={pauseAnimationsOnBattery}
          onCheckedChange={onPauseAnimationsOnBatteryChange}
          disabled={!doubutsu}
          label="Pause always-on animations on battery"
          description="The drifting wallpaper redraws the window every frame. It picks up again when plugged in."
        />
      )}
      {villageLife}
    </section>
  );
}

// A labelled palette row, greyed while Boring mode is on.
function PaletteRow({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p
        className={cn(
          "text-xs text-muted-foreground",
          disabled && "opacity-50",
        )}
      >
        {label}
      </p>
      {children}
    </div>
  );
}
