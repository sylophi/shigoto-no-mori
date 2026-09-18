// The one lifecycle choice a pull offers: whether the create on this
// device runs the setup script. The script is the LOCAL project's, so
// the row reads under LocalHostScope. A project without one shows the
// switch off and pinned, so the row still says why nothing will run.
// Carry-over and port provision are not on offer: they run either way.
import type { Project } from "@shared/schemas";
import { SectionHeading } from "@/components/ui/section-heading";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useCreatePlan } from "./createPlan";
import { CARD } from "./TransplantChrome";

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
  // The whole plan, not just the script: the running view lists its
  // steps from the same reads, and having them settled here means the
  // list is complete from its first frame instead of growing a row.
  const command = useCreatePlan(localProject).setupCommand;
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
              Follows the leave-out rule: on when something stays behind.
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
