import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { Switch } from "@/components/ui/switch";
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

  // resolvedPaths come trailing-slash-stripped, so re-add the directory
  // form; otherwise a manual entry nested under a covered directory
  // (node_modules/some-pkg under node_modules/) would miss its badge
  // while creation-time reconciliation would still remove it.
  const isCovered =
    useWorktreeInclude && status?.fileExists
      ? makeIgnoreMatcher(status.resolvedPaths.flatMap((p) => [p, `${p}/`]))
      : () => false;

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Carry over</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Files and folders from the main checkout to copy or symlink into every
          new worktree. Useful for things git ignores, like{" "}
          <span className="font-mono">.env</span>,{" "}
          <span className="font-mono">node_modules</span>, or editor state.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
            .worktreeinclude
          </span>
          <Switch
            checked={useWorktreeInclude}
            onCheckedChange={onToggleUseWorktreeInclude}
            aria-label="Use .worktreeinclude"
          />
        </div>
        <div className="border-t border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Gitignored files matching these patterns are copied into every new
            worktree. The file lives in your repo; edit it there.
          </p>
          {!useWorktreeInclude ? (
            <p className="mt-2 text-xs text-muted-foreground/70">
              Disabled for this project.
            </p>
          ) : !status ? null : !status.fileExists ? (
            <p className="mt-2 text-xs text-muted-foreground/70">
              No <span className="font-mono">.worktreeinclude</span> file at the
              repo root.
            </p>
          ) : (
            <>
              {status.patterns.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {status.patterns.map((pattern, idx) => (
                    // Duplicate pattern lines are legal gitignore syntax.
                    // oxlint-disable-next-line react/no-array-index-key
                    <li key={idx} className="font-mono text-xs">
                      {pattern}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground/70">
                {status.patterns.length === 0
                  ? "The file has no patterns."
                  : `Matches ${status.resolvedPaths.length} gitignored ${
                      status.resolvedPaths.length === 1 ? "path" : "paths"
                    }.`}
              </p>
            </>
          )}
        </div>
      </div>

      {entries.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Manual entries
          </p>
          {entries.map((entry) => (
            <CarryOverRow
              key={entry.path}
              entry={entry}
              projectPath={projectPath}
              covered={isCovered(normalizeRelPath(entry.path))}
              onChangeMode={(mode) => onChangeMode(entry.path, mode)}
              onRemove={() => onRemove(entry.path)}
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
          key={projectPath}
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
