import { Button } from "@/components/ui/button";
import { LauncherIcon } from "@/components/LauncherIcon";
import { SectionHeading } from "@/components/ui/section-heading";
import { cn } from "@/lib/utils";
import type { DetectedLauncher } from "@shared/schemas";

interface DetectedToolsSectionProps {
  // Detected AND available; the not-installed remainder is its own section.
  tools: DetectedLauncher[];
  hidden: string[];
  onToggle: (id: string) => void;
}

// Every detected tool is shown in the launcher row by default. Each pill is
// a toggle: filled (secondary) = shown, dimmed outline = hidden. Same
// selected/unselected vocabulary as AppearanceSection, so doubutsu picks it
// up through the existing button slots.
export function DetectedToolsSection({
  tools,
  hidden,
  onToggle,
}: DetectedToolsSectionProps) {
  const hiddenSet = new Set(hidden);
  const hiddenCount = tools.filter((t) => hiddenSet.has(t.id)).length;

  return (
    <section className="space-y-4">
      <div>
        <SectionHeading className="mb-1">Detected tools</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Editors and tools found on this machine. Click to toggle visibility in
          the Launch section.
        </p>
      </div>
      {tools.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          Nothing detected yet. Install a supported tool below and Shigomori
          will pick it up on next launch.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {tools.map((tool) => {
              const isHidden = hiddenSet.has(tool.id);
              return (
                <Button
                  key={tool.id}
                  variant={isHidden ? "outline" : "secondary"}
                  size="sm"
                  aria-pressed={!isHidden}
                  title={
                    isHidden
                      ? `Show ${tool.label} in the Launch section`
                      : `Hide ${tool.label} from the Launch section`
                  }
                  className={cn(isHidden && "opacity-50 hover:opacity-100")}
                  onClick={() => onToggle(tool.id)}
                >
                  <LauncherIcon entry={tool} className="size-3.5" />
                  {tool.label}
                </Button>
              );
            })}
          </div>
          {hiddenCount > 0 && (
            <p className="text-xs text-muted-foreground/70">
              {hiddenCount} of {tools.length} hidden from the Launch section.
            </p>
          )}
        </>
      )}
    </section>
  );
}
