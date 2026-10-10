// The Configure page's "All devices" tab: the project's shared
// settings, the ones that are about the repo across every device that
// holds it rather than any one device's project file. They apply the
// moment they are picked (no Save, unlike the device tabs' form) and
// travel straight between the devices, so a device that is off takes
// them up when it is next online with another.
import type { Project } from "@shigomori/contracts/schemas";
import { CreateOnSection } from "./CreateOnSection";
import { LeaveOutSection } from "./LeaveOutSection";
import { ConfigureSharedView } from "@shigomori/ui/views/configure/ConfigureProjectView.tsx";

export function ConfigureShared({ project }: { project: Project }) {
  return (
    <ConfigureSharedView>
      <CreateOnSection project={project} />
      <LeaveOutSection project={project} />
    </ConfigureSharedView>
  );
}
