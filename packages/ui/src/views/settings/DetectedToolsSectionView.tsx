import { Button } from "../../primitives/button.tsx";
import { LauncherIconView } from "../shared/LauncherIconView.tsx";
import { SectionIntro } from "../../primitives/section-heading.tsx";
import { cn } from "../../lib/utils.ts";
import type { DetectedLauncher } from "@shigomori/contracts/schemas/index";

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
export function DetectedToolsSectionView({
  tools,
  hidden,
  onToggle,
}: DetectedToolsSectionProps) {
  const hiddenSet = new Set(hidden);
  const hiddenCount = tools.filter((t) => hiddenSet.has(t.id)).length;

  return (
    <section className="space-y-4">
      <SectionIntro title="Detected tools">
        Editors and tools found on this machine. Click to toggle visibility in
        the Launch section.
      </SectionIntro>
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
                  className={cn(isHidden && "opacity-50 hover:opacity-100")}
                  onClick={() => onToggle(tool.id)}
                >
                  <LauncherIconView entry={tool} className="size-3.5" />
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
