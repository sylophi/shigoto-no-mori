// The remote worktree detail's cross-device actions: pull a copy here
// ("Bring here") or move it here and tear down the source
// ("Transplant"). Text buttons rather than the forest's icon pair —
// the footer has room to say what they do. Renders nothing unless the
// caller holds command access, the branch is real, and a local project
// shares the repo identity (the same gate the forest rows apply; the
// handler re-verifies it).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Loader2, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { projectsQueryOptions } from "@/hooks/projects/useProjects";
import { useBringWorktreeHere } from "@/hooks/remote/useBringWorktreeHere";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevices } from "@/hooks/remote/useRemoteDevices";
import { TransplantDialog } from "./TransplantDialog";

export function RemoteWorktreeActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const { granted } = useCommandAccess();
  // The LOCAL device's projects (explicitly scope-less despite the
  // surrounding remote provider): a worktree can only land in a local
  // project sharing the repo's identity.
  const { data: localProjects = [] } = useQuery(projectsQueryOptions({}));
  const localProject =
    project.identity != null
      ? localProjects.find(
          (local) =>
            local.identity != null && local.identity === project.identity,
        )
      : undefined;

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
        sourceProjectId={project.id}
        sourceIdentity={project.identity}
        localProjectId={localProject.id}
      />
    </div>
  );
}

// Transplant is destructive on the remote side, so it opens the review
// dialog instead of firing on a double-click: the dialog is the
// confirmation.
function TransplantButton({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
}) {
  const [open, setOpen] = useState(false);
  const { deviceId } = useHostScope();
  const deviceLabel =
    useRemoteDevices().find((entry) => entry.deviceId === deviceId)?.label ??
    "the device";
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
          sourceProjectId={sourceProjectId}
          sourceIdentity={sourceIdentity}
          sourceDeviceLabel={deviceLabel}
          localProjectId={localProjectId}
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
  const bring = useBringWorktreeHere({ ...props, transplant: false });
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
