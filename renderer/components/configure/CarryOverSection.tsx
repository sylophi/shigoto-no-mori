import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { Switch } from "@/components/ui/switch";
import { ExternalLink } from "@/components/ui/external-link";
import { useCarryOverStats } from "@/hooks/projects/useCarryOverStats";
import { worktreeIncludeExtras } from "@/hooks/projects/carryOverPaths";
import { useWorktreeIncludeStatus } from "@/hooks/projects/useWorktreeIncludeStatus";
import { makeIgnoreMatcher, normalizeRelPath } from "@shared/gitPaths";
import type { CarryOverEntry } from "@shared/schemas";
import { CarryOverPickerModal } from "./CarryOverPickerModal";
import { CarryOverRow } from "./CarryOverRow";

interface CarryOverSectionProps {
  projectId: string;
  projectPath: string;
  entries: CarryOverEntry[];
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
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Carry over</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Files and folders to copy or symlink into every new worktree, taken
          from the main checkout or, failing that, another worktree that has
          them (symlinks only ever point at the main checkout). Useful for
          things git ignores, like <span className="font-mono">.env</span>,{" "}
          <span className="font-mono">node_modules</span>, or editor state.
        </p>
      </div>

      {(status?.fileExists || !useWorktreeInclude) && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">
              Use <span className="font-mono">.worktreeinclude</span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {useWorktreeInclude &&
              status?.fileExists &&
              status.matchedPaths.length === 0
                ? "No gitignored files match its patterns."
                : "Copies matching gitignored files into every new worktree."}{" "}
              <ExternalLink
                href="https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees"
                errorTitle="Couldn't open docs"
              />
            </p>
          </div>
          <Switch
            checked={useWorktreeInclude}
            onCheckedChange={onToggleUseWorktreeInclude}
            aria-label="Use .worktreeinclude"
          />
        </div>
      )}

      {(entries.length > 0 || includePaths.length > 0) && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <CarryOverRow
              key={entry.path}
              entry={entry}
              stat={stats?.[entry.path]}
              covered={isCovered(normalizeRelPath(entry.path))}
              onChangeMode={(mode) => onChangeMode(entry.path, mode)}
              onRemove={() => onRemove(entry.path)}
            />
          ))}
          {includePaths.map((path) => (
            <CarryOverRow
              key={`worktreeinclude:${path}`}
              entry={{ path, mode: "copy" }}
              stat={stats?.[path]}
              origin="worktreeinclude"
            />
          ))}
        </div>
      )}

      <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
        <Plus />
        Add file or folder
      </Button>

      {picking && (
        <CarryOverPickerModal
          projectId={projectId}
          projectPath={projectPath}
          selectedPaths={selectedPaths}
          isCovered={isCovered}
          onPick={(entry) => onAdd(entry)}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}
