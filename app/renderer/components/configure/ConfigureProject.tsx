import type { ReactNode } from "react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { useProjectConfigSeed } from "@/hooks/config/useProjectConfigSeed";
import { useRoutedProject } from "@/hooks/projects/useProjectNav";
import { useProjectSettingsSync } from "@/hooks/sharedSettings/useProjectSettingsSync";
import type { Project } from "@shigomori/contracts/schemas";
import { ConfigureForm } from "./ConfigureForm";
import {
  ConfigureLoadFailureView,
  ConfigureSharedView,
} from "@shigomori/ui/views/configure/ConfigureProjectView.tsx";
import { ConfigureShared } from "./ConfigureShared";
import { ConfigureSkeletonView } from "@shigomori/ui/views/configure/ConfigureSkeletonView.tsx";

export function ConfigureProject() {
  const synced = useProjectSettingsSync(useRoutedProject()?.identity);
  return (
    <ProjectDevicePage
      title="Configure"
      renderAllDevices={(project) => (
        <ConfigureSharedView>
          <ConfigureShared project={project} />
        </ConfigureSharedView>
      )}
      devicesLocked={synced}
    >
      {(scoped, _tab, locked) => (
        // One form for every device, under the shared sections.
        <ConfigureBody
          project={scoped}
          leading={locked && <ConfigureShared project={scoped} />}
        />
      )}
    </ProjectDevicePage>
  );
}

// The form for whichever device the surrounding scope names, seeded
// from that device's project file and default branch.
function ConfigureBody({
  project,
  leading,
}: {
  project: Project;
  leading: ReactNode;
}) {
  const seed = useProjectConfigSeed(project.id);
  if (seed.state === "failed") {
    return (
      <ConfigureLoadFailureView message={seed.message} onRetry={seed.retry} />
    );
  }
  if (seed.state === "loading") return <ConfigureSkeletonView />;
  return (
    <ConfigureForm
      key={project.id}
      projectId={project.id}
      projectPath={project.path}
      initialConfig={seed.config}
      resolvedDefaultBranch={seed.resolvedDefaultBranch}
      leading={leading}
    />
  );
}
