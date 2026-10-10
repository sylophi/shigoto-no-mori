import { ProjectIcon } from "@/components/shared/ProjectIcon";
import type { RowStatus } from "@shigomori/ui/primitives/row-status.tsx";
import type { TidyEntry } from "@shigomori/ui/views/tidy/tidyModel.ts";
import { TidyRowView } from "@shigomori/ui/views/tidy/TidyRowView.tsx";

// One worktree in the tidy list (TidyRowView), its project's icon read
// through the scope's api.
export function TidyRow(props: {
  entry: TidyEntry;
  checked: boolean;
  status: RowStatus;
  disabled: boolean;
  onToggle: () => void;
  showProject: boolean;
}) {
  const { project } = props.entry;
  return (
    <TidyRowView
      {...props}
      icon={
        <ProjectIcon
          projectId={project.id}
          name={project.name}
          className="size-3"
        />
      }
    />
  );
}
