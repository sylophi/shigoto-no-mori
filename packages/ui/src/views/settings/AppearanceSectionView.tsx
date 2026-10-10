import type { ReactNode } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { SegmentedControl } from "../../primitives/segmented-control.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import type { Theme } from "@shigomori/contracts/schemas/index";
import { ToggleRowView } from "../shared/ToggleRowView.tsx";
import { cn } from "../../lib/utils.ts";

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
];

export interface AppearanceSectionViewProps {
  theme: Theme;
  onPick: (theme: Theme) => void;
  doubutsu: boolean;
  onDoubutsuChange: (next: boolean) => void;
  pauseAnimationsOnBattery: boolean;
  onPauseAnimationsOnBatteryChange: (next: boolean) => void;
  // A browser without the Battery Status API has nothing to pause on.
  battery: boolean;
  // The two palette picks (ThemePicker).
  lightPalette: ReactNode;
  darkPalette: ReactNode;
  // Village life, where this window has it.
  villageLife: ReactNode;
  // "Appearance" where the section stands alone (the web page). The
  // desktop's Appearance section already says that and names it "Theme".
  heading?: string;
}

export function AppearanceSectionView({
  theme,
  onPick,
  doubutsu,
  onDoubutsuChange,
  pauseAnimationsOnBattery,
  onPauseAnimationsOnBatteryChange,
  battery,
  lightPalette,
  darkPalette,
  villageLife,
  heading = "Appearance",
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
      <SectionHeading className="mb-1">{heading}</SectionHeading>
      <SegmentedControl
        aria-label="Theme"
        value={theme}
        onChange={onPick}
        options={options}
        optionClassName="px-3 py-1.5 text-xs"
      />
      <ToggleRowView
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
        <PaletteRow label="Light palette" disabled={!doubutsu}>
          {lightPalette}
        </PaletteRow>
        <PaletteRow label="Dark palette" disabled={!doubutsu}>
          {darkPalette}
        </PaletteRow>
      </div>
      {/* A browser without the Battery Status API has nothing to pause
          on, and neither does the plain look: the wallpaper is doubutsu's. */}
      {battery && (
        <ToggleRowView
          checked={pauseAnimationsOnBattery}
          onCheckedChange={onPauseAnimationsOnBatteryChange}
          disabled={!doubutsu}
          label="Pause always-on animations on battery"
          description="The drifting wallpaper redraws the window every frame, even when nothing else is happening. Pausing it while this machine runs on battery saves energy, and it picks up again when plugged in."
        />
      )}
      {villageLife}
    </section>
  );
}

// A labelled palette row under the switch, greyed with it.
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
