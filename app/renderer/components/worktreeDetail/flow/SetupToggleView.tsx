// The setup switch's look (SetupToggle.tsx reads the command it names):
// the script the create would run on the landing device, or why there
// is none, beside the switch. Without a command the switch shows off
// and pinned.
import { SectionHeading } from "@/components/ui/section-heading";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { CARD } from "./FlowChromeView";

export function SetupToggleView({
  thisDeviceLabel,
  command,
  checked,
  onChange,
}: {
  thisDeviceLabel: string;
  // The landing project's setup command, "" when none is configured.
  command: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const configured = command !== "";
  return (
    <section className="space-y-2">
      <SectionHeading>Setup on {thisDeviceLabel}</SectionHeading>
      <div className={cn(CARD, "flex items-center gap-3")}>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Run the setup script</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {configured ? (
              <span className="font-mono">{command}</span>
            ) : (
              "No setup script is configured for this project."
            )}
          </p>
        </div>
        <Switch
          checked={checked && configured}
          disabled={!configured}
          onCheckedChange={onChange}
          aria-label="Run the setup script"
        />
      </div>
    </section>
  );
}
