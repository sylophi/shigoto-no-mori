// The Configure page's "All devices" sections: the project's shared
// settings, the ones that are about the repo across every device that
// holds it rather than any one device's project file. They apply the
// moment they are picked (no Save, unlike the device tabs' form) and
// travel straight between the devices, so a device that is off takes
// them up when it is next online with another.
import type { Project } from "@shigomori/contracts/schemas";
import {
  useProjectSettingsSync,
  useSetProjectSettingsSync,
} from "@/hooks/sharedSettings/useProjectSettingsSync";
import { CreateOnSection } from "./CreateOnSection";
import { LeaveOutSection } from "./LeaveOutSection";
import { SyncSettingsSectionView } from "@shigomori/ui/views/configure/ConfigureProjectView.tsx";

export function ConfigureShared({ project }: { project: Project }) {
  const synced = useProjectSettingsSync(project.identity);
  const setSynced = useSetProjectSettingsSync(project.id);
  return (
    <>
      <SyncSettingsSectionView checked={synced} onCheckedChange={setSynced} />
      <CreateOnSection project={project} />
      <LeaveOutSection project={project} />
    </>
  );
}
