// The Configure page's "All devices" tab: the project's shared
// settings, the ones that are about the repo across every device that
// holds it rather than any one device's project file. They apply the
// moment they are picked (no Save, unlike the device tabs' form) and
// travel straight between the devices, so a device that is off takes
// them up when it is next online with another.
import type { Project } from "@shared/schemas";
import { CreateOnSection } from "./CreateOnSection";
import { LeaveOutSection } from "./LeaveOutSection";
import { PAGE_BODY } from "@/components/shared/PageShell";

export function ConfigureShared({ project }: { project: Project }) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex max-w-3xl flex-col gap-10">
        <CreateOnSection project={project} />
        <LeaveOutSection project={project} />
      </div>
    </div>
  );
}
