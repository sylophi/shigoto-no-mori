// The one lifecycle choice a pull offers: whether the create on this
// device runs the setup script. The script is the LOCAL project's, so
// the row reads under LocalHostScope. A project without one shows the
// switch off and pinned, so the row still says why nothing will run.
// Carry-over and port provision are not on offer: they run either way.
import type { Project } from "@shared/schemas";
import { useCreatePlan } from "./createPlan";
import { SetupToggleView } from "./SetupToggleView";

export function SetupToggle({
  localProject,
  thisDeviceLabel,
  checked,
  onChange,
}: {
  localProject: Project;
  thisDeviceLabel: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  // The whole plan, not just the script: the running view lists its
  // steps from the same reads, and having them settled here means the
  // list is complete from its first frame instead of growing a row.
  const command = useCreatePlan(localProject).setupCommand;
  return (
    <SetupToggleView
      thisDeviceLabel={thisDeviceLabel}
      command={command}
      checked={checked}
      onChange={onChange}
    />
  );
}
