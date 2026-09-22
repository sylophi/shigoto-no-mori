import { Moon, Sun, SunMoon } from "lucide-react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SectionHeading } from "@/components/ui/section-heading";
import type { Theme } from "@shared/schemas";
import { ToggleRow } from "@/components/shared/ToggleRow";

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
];

// The battery pause reads the power source through the Battery Status
// API (usePauseAnimationsOnBattery), which Chromium has and Safari and
// Firefox do not, so a browser without it gets no toggle.
const batterySupported =
  typeof navigator !== "undefined" && "getBattery" in navigator;

interface AppearanceSectionProps {
  theme: Theme;
  onPick: (theme: Theme) => void;
  doubutsu: boolean;
  onDoubutsuChange: (next: boolean) => void;
  pauseAnimationsOnBattery: boolean;
  onPauseAnimationsOnBatteryChange: (next: boolean) => void;
  // "Appearance" where the section stands alone (the web page). The
  // desktop's Appearance section already says that and names it "Theme".
  heading?: string;
}

export function AppearanceSection({
  theme,
  onPick,
  doubutsu,
  onDoubutsuChange,
  pauseAnimationsOnBattery,
  onPauseAnimationsOnBatteryChange,
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
        label="Doubutsu mode"
        description="Bold, color-blocked Animal Crossing inspired theme. Layers on top of light and dark; turn off for the plain, neutral look."
      />
      {batterySupported && (
        <ToggleRow
          checked={pauseAnimationsOnBattery}
          onCheckedChange={onPauseAnimationsOnBatteryChange}
          label="Pause always-on animations on battery"
          description="The drifting wallpaper redraws the window every frame, even when nothing else is happening. Pausing it while this machine runs on battery saves energy, and it picks up again when plugged in."
        />
      )}
    </section>
  );
}
