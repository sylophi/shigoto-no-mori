import { Moon, Sun, SunMoon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import type { Theme } from "@shared/schemas";

interface AppearanceSectionProps {
  theme: Theme;
  onPick: (theme: Theme) => void;
}

export function AppearanceSection({ theme, onPick }: AppearanceSectionProps) {
  const options: { value: Theme; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: "Light", Icon: Sun },
    { value: "dark", label: "Dark", Icon: Moon },
    { value: "system", label: "System", Icon: SunMoon },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading className="mb-1">Appearance</SectionHeading>
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
    </section>
  );
}
