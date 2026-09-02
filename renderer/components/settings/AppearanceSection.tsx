import { Moon, Sun, SunMoon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import type { Theme } from "@shared/schemas";
import { ToggleRow } from "./ToggleRow";

interface AppearanceSectionProps {
  theme: Theme;
  onPick: (theme: Theme) => void;
  doubutsu: boolean;
  onDoubutsuChange: (next: boolean) => void;
  // "Appearance" where the section stands alone (the web page). The
  // desktop's Appearance section already says that and names it "Theme".
  heading?: string;
}

export function AppearanceSection({
  theme,
  onPick,
  doubutsu,
  onDoubutsuChange,
  heading = "Appearance",
}: AppearanceSectionProps) {
  const options: { value: Theme; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
    { value: "system", label: "System", Icon: SunMoon },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">{heading}</SectionHeading>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map(({ value, label, Icon }) => (
          <Button
            key={value}
            variant={theme === value ? "secondary" : "outline"}
            size="sm"
            onClick={() => onPick(value)}
          >
            <Icon />
            {label}
          </Button>
        ))}
      </div>
      <ToggleRow
        checked={doubutsu}
        onCheckedChange={onDoubutsuChange}
        label="Doubutsu mode"
        description="Bold, color-blocked Animal Crossing inspired theme. Layers on top of light and dark; turn off for the plain, neutral look."
      />
    </section>
  );
}
