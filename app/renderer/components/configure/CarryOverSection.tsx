import { useState } from "react";
import { useCarryOverStats } from "@/hooks/projects/useCarryOverStats";
import { worktreeIncludeExtras } from "@/lib/carryOverPaths";
import { useWorktreeIncludeStatus } from "@/hooks/projects/useWorktreeIncludeStatus";
import { makeIgnoreMatcher } from "@shigomori/contracts/git/gitPaths";
import type { CarryOverEntry } from "@shigomori/contracts/schemas";
import { CarryOverPickerModal } from "./CarryOverPickerModal";
import { CarryOverSectionView } from "@shigomori/ui/views/configure/CarryOverSectionView.tsx";

interface CarryOverSectionProps {
  projectId: string;
  projectPath: string;
  entries: readonly CarryOverEntry[];
  useWorktreeInclude: boolean;
  onToggleUseWorktreeInclude: (enabled: boolean) => void;
  onAdd: (entry: CarryOverEntry) => void;
  onChangeMode: (path: string, mode: CarryOverEntry["mode"]) => void;
  onRemove: (path: string) => void;
}

export function CarryOverSection({
  projectId,
  projectPath,
  entries,
  useWorktreeInclude,
  onToggleUseWorktreeInclude,
  onAdd,
  onChangeMode,
  onRemove,
}: CarryOverSectionProps) {
  const [picking, setPicking] = useState(false);
  const selectedPaths = new Set(entries.map((e) => e.path));
  const { data: status } = useWorktreeIncludeStatus(projectId);

  // matchedPaths keep git's raw shape (directories keep their trailing
  // slash), the same input creation-time reconciliation matches against,
  // so the covered badge and the actual auto-removal always agree.
  const isCovered =
    useWorktreeInclude && status?.fileExists
      ? makeIgnoreMatcher(status.matchedPaths)
      : () => false;

  // .worktreeinclude matches render as read-only rows in the same list as
  // manual entries.
  const includePaths = worktreeIncludeExtras(
    entries,
    useWorktreeInclude,
    status,
  );
  const { data: stats } = useCarryOverStats(projectId, [
    ...entries.map((e) => e.path),
    ...includePaths,
  ]);

  return (
    <CarryOverSectionView
      entries={entries}
      includePaths={includePaths}
      stats={stats}
      isCovered={isCovered}
      includeFileExists={status?.fileExists === true}
      noMatches={
        status?.fileExists === true && status.matchedPaths.length === 0
      }
      useWorktreeInclude={useWorktreeInclude}
      onToggleUseWorktreeInclude={onToggleUseWorktreeInclude}
      onChangeMode={onChangeMode}
      onRemove={onRemove}
      onPickPath={() => setPicking(true)}
      picker={
        picking && (
          <CarryOverPickerModal
            projectId={projectId}
            projectPath={projectPath}
            selectedPaths={selectedPaths}
            isCovered={isCovered}
            onPick={(entry) => onAdd(entry)}
            onClose={() => setPicking(false)}
          />
        )
      }
    />
  );
}
