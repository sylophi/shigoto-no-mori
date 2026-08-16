import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useLauncherForProject } from "@/hooks/launchers/useLaunchers";
import type { LaunchSet } from "@shared/schemas";
import { LaunchSetRow } from "./LaunchSetRow";

interface LaunchSetsSectionProps {
  projectId: string;
  sets: LaunchSet[];
  autoLaunchSetId: string | null;
  onAdd: () => void;
  onRename: (setId: string, label: string) => void;
  onRemove: (setId: string) => void;
  onAddMember: (setId: string, launcherId: string) => void;
  onRemoveMember: (setId: string, launcherId: string) => void;
  onMoveMember: (setId: string, draggedId: string, targetId: string) => void;
  onToggleAutoLaunch: (setId: string, enabled: boolean) => void;
}

export function LaunchSetsSection({
  projectId,
  sets,
  autoLaunchSetId,
  onAdd,
  onRename,
  onRemove,
  onAddMember,
  onRemoveMember,
  onMoveMember,
  onToggleAutoLaunch,
}: LaunchSetsSectionProps) {
  // The same list the Launch row shows, so the tools offered here are
  // exactly the pills the user recognizes -- including the ones this
  // project already saved. Tools added in the draft above appear once
  // the config is saved.
  const { data } = useLauncherForProject(projectId);
  const entries = data?.entries ?? [];

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Launch sets</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Groups of tools opened together from one pill in the Launch row. Handy
          for the editor + terminal + agent trio you open in every worktree.
        </p>
      </div>

      {sets.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          None yet. Without a set, nothing about launching changes.
        </p>
      ) : (
        <div className="space-y-2">
          {sets.map((set) => (
            <LaunchSetRow
              key={set.id}
              set={set}
              entries={entries}
              autoLaunch={autoLaunchSetId === set.id}
              onRename={(label) => onRename(set.id, label)}
              onRemove={() => onRemove(set.id)}
              onAddMember={(launcherId) => onAddMember(set.id, launcherId)}
              onRemoveMember={(launcherId) =>
                onRemoveMember(set.id, launcherId)
              }
              onMoveMember={(draggedId, targetId) =>
                onMoveMember(set.id, draggedId, targetId)
              }
              onToggleAutoLaunch={(enabled) =>
                onToggleAutoLaunch(set.id, enabled)
              }
            />
          ))}
        </div>
      )}

      {sets.length > 0 && (
        <p className="text-xs text-muted-foreground/70">
          Only one set can run on create, and it's skipped when the setup script
          fails.
        </p>
      )}

      <Button variant="ghost" size="sm" onClick={onAdd}>
        <Plus />
        Add launch set
      </Button>
    </section>
  );
}
