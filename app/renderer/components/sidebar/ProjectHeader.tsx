import {
  useMarkTerrierProjects,
  useTerrierMarksHere,
} from "@/hooks/config/useSidebarMarks";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import type { Project } from "@shared/schemas";
import {
  ProjectHeaderView,
  type ProjectHeaderViewProps,
} from "./ProjectHeaderView";

// The view's props, with the project standing in for what is looked up
// from it.
type ProjectHeaderProps = Omit<
  ProjectHeaderViewProps,
  "name" | "iconSrc" | "showTerrierPaw" | "nameRef" | "isTruncated"
> & {
  project: Project;
  // Whose icon to show when it isn't this scope's own `project`: a
  // project only peers hold reads it off one of them.
  iconFrom?: { projectId: string; deviceId: string };
  // Some checkout in the header's group is terrier-sourced, which puts
  // the paw after the open project's name while Mark terrier projects
  // is on.
  terrier?: boolean;
};

// A project header's name and icon (ProjectHeaderView), with the icon
// looked up, the paw weighed against this window's Mark terrier
// projects, and the name measured for overflow: `useIsTruncated`
// suppresses redundant tooltips on names that already fit.
export function ProjectHeader({
  project,
  iconFrom,
  terrier = false,
  ...props
}: ProjectHeaderProps) {
  const { arrangeMode, missing, expanded } = props;
  // Keyed on what swaps or refills the name span, which a ResizeObserver
  // on the old span would miss.
  const [nameRef, isTruncated] = useIsTruncated<HTMLSpanElement>(
    `${arrangeMode}:${missing}:${expanded}:${project.name}`,
  );
  const iconSrc = useProjectIcon(
    iconFrom?.projectId ?? project.id,
    iconFrom?.deviceId,
  );
  // Mark terrier projects is on, and this window shows its marks.
  const mark = useMarkTerrierProjects();
  const here = useTerrierMarksHere();
  return (
    <ProjectHeaderView
      name={project.name}
      iconSrc={iconSrc}
      showTerrierPaw={mark && here && terrier}
      nameRef={nameRef}
      isTruncated={isTruncated}
      {...props}
    />
  );
}
