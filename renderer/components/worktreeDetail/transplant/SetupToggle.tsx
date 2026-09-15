// The one lifecycle choice a pull offers: whether the create on this
// device runs the setup script. The script is the LOCAL project's, so
// the row reads under LocalHostScope. A project without one shows the
// switch off and pinned, so the row still says why nothing will run.
// Carry-over and port provision are not on offer: they run either way.
import type { Project } from "@shared/schemas";
import { SectionHeading } from "@/components/ui/section-heading";
import { Switch } from "@/components/ui/switch";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { cn } from "@/lib/utils";
import { CARD } from "./TransplantChrome";

// The local project's setup command, "" when none is configured (or
// the config has not loaded yet). The switch and the transplant's
// "What happens" note read the same answer, so neither promises a
// script the other knows is missing.
export function useSetupScript(localProject: Project): string {
  const { data: config } = useShigomoriConfig(localProject.id);
  return config?.scripts?.setup?.trim() ?? "";
}

export function SetupToggle({
  localProject,
  thisDeviceLabel,
  checked,
  onChange,
  pinned,
}: {
  localProject: Project;
  thisDeviceLabel: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  // Whether the user set the switch. Until then it follows the
  // leave-out rule, and the row says so.
  pinned: boolean;
}) {
  const command = useSetupScript(localProject);
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
          {!pinned && configured && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Follows the leave-out rule: on when nothing stays behind.
            </p>
          )}
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
