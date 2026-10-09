// A project's icon (ProjectIconView), its logo read off the device the
// project lives on. `deviceId` names that machine when the caller is
// not inside its scope (see useProjectIcon).
import { ProjectIconView } from "@/components/shared/ProjectIconView";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";

export function ProjectIcon({
  projectId,
  name,
  deviceId,
  className,
}: {
  projectId: string;
  name: string;
  deviceId?: string;
  className?: string;
}) {
  return (
    <ProjectIconView
      src={useProjectIcon(projectId, deviceId)}
      name={name}
      className={className}
    />
  );
}
