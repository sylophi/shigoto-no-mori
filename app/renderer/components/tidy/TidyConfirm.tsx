import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { ModalShell } from "@shigomori/ui/primitives/modal-shell.tsx";
import type { TidySummary } from "./tidyModel";
import { TidyConfirmView } from "./TidyConfirmView";

// The removal's confirm (TidyConfirmView), each project with its icon.
export function TidyConfirm({
  summary,
  deleteBranches,
  onCancel,
  onConfirm,
}: {
  summary: TidySummary;
  deleteBranches: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const icons = new Map(
    summary.selected.map(({ project }) => [
      project.id,
      <ProjectIcon
        key={project.id}
        projectId={project.id}
        name={project.name}
        className="size-3"
      />,
    ]),
  );
  return (
    <ModalShell onClose={onCancel} popoverClassName="max-w-lg">
      <TidyConfirmView
        summary={summary}
        deleteBranches={deleteBranches}
        icons={icons}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </ModalShell>
  );
}
