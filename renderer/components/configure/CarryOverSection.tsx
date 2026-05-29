import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import type { CarryOverEntry } from "@shared/schemas";
import { CarryOverPickerModal } from "./CarryOverPickerModal";
import { CarryOverRow } from "./CarryOverRow";

interface CarryOverSectionProps {
  projectId: string;
  projectPath: string;
  entries: CarryOverEntry[];
  onAdd: (entry: CarryOverEntry) => void;
  onChangeMode: (path: string, mode: CarryOverEntry["mode"]) => void;
  onRemove: (path: string) => void;
}

export function CarryOverSection({
  projectId,
  projectPath,
  entries,
  onAdd,
  onChangeMode,
  onRemove,
}: CarryOverSectionProps) {
  const [picking, setPicking] = useState(false);
  const selectedPaths = new Set(entries.map((e) => e.path));

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

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <CarryOverRow
              key={entry.path}
              entry={entry}
              projectPath={projectPath}
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
          onPick={(entry) => onAdd(entry)}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}
