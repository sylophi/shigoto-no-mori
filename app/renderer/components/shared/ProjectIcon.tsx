import { useProjectIcon } from "@/hooks/projects/useProjectIcon";
import { ProjectIconView } from "./ProjectIconView";

// A project's icon (ProjectIconView), with its logo looked up.
// `deviceId` names the machine the project lives on when the caller is
// not inside that device's scope (see useProjectIcon).
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
  const src = useProjectIcon(projectId, deviceId);
  return <ProjectIconView name={name} src={src} className={className} />;
}
