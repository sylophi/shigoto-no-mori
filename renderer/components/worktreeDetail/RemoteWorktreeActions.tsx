// The remote worktree detail's cross-device actions: pull a copy here
// ("Bring here") or move it here and tear down the source
// ("Transplant"). Text buttons, since the footer has room to say what
// they do. Renders nothing unless the caller holds command access, the
// branch is real, and a local project shares the repo identity (the
// handler re-verifies that last one).
import { useState } from "react";
import { ArrowDownToLine, Loader2, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { useBringWorktreeHere } from "@/hooks/remote/useBringWorktreeHere";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { TransplantDialog } from "./transplant/TransplantDialog";

export function RemoteWorktreeActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const { granted } = useCommandAccess();
  const localProject = useLocalProjectForIdentity(project.identity);

  if (
    !granted ||
    worktree.isPrimary ||
    worktree.detached ||
    !isRealBranch(worktree.branch) ||
    project.identity == null ||
    localProject === undefined
  ) {
    return null;
  }
  return (
    <div className="flex items-center gap-1">
      <BringButton
        worktree={worktree}
        sourceProjectId={project.id}
        sourceIdentity={project.identity}
        localProjectId={localProject.id}
      />
      <TransplantButton
        worktree={worktree}
        project={project}
        sourceIdentity={project.identity}
        localProject={localProject}
      />
    </div>
  );
}

// Transplant is destructive on the remote side, so it opens the review
// dialog instead of firing on a double-click: the dialog is the
// confirmation.
function TransplantButton({
  worktree,
  project,
  sourceIdentity,
  localProject,
}: {
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  localProject: Project;
}) {
  const [open, setOpen] = useState(false);
  const { deviceId } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title="Move this worktree to this machine and tear down the copy over there"
        onClick={() => setOpen(true)}
      >
        <Shovel />
        Transplant here
      </Button>
      {open && (
        <TransplantDialog
          worktree={worktree}
          project={project}
          sourceIdentity={sourceIdentity}
          localProject={localProject}
          sourceDeviceLabel={deviceLabel}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BringButton(props: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
}) {
  const bring = useBringWorktreeHere(props);
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={bring.isPending}
      title="Create this worktree on this machine, uncommitted changes included"
      onClick={() => bring.mutate()}
    >
      {bring.isPending ? (
        <Loader2 className="animate-spin" />
      ) : (
        <ArrowDownToLine />
      )}
      {bring.isPending ? "Bringing here…" : "Bring here"}
    </Button>
  );
}
