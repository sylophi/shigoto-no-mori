// The remote worktree detail's cross-device actions: pull a copy here
// ("Bring here"), keep a live mirror of it here ("Mirror here"), or
// move it here and tear down the source ("Transplant"). Text buttons,
// since the footer has room to say what they do. Renders nothing unless the caller holds command access, the
// branch is real, and a local project shares the repo identity (the
// handler re-verifies that last one).
import { type ReactNode, useState } from "react";
import { ArrowDownToLine, Loader2, RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { useBringWorktreeHere } from "@/hooks/remote/useBringWorktreeHere";
import { useStartMirror } from "@/hooks/remote/useMirrors";
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
      <MirrorButton
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
      <ActionButton
        icon={<Shovel />}
        label="Transplant here"
        pendingLabel="Transplant here"
        title="Move this worktree to this machine and tear down the copy over there"
        pending={false}
        onClick={() => setOpen(true)}
      />
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

type LandingProps = {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
};

function BringButton(props: LandingProps) {
  const bring = useBringWorktreeHere(props);
  return (
    <ActionButton
      icon={<ArrowDownToLine />}
      label="Bring here"
      pendingLabel="Bringing here…"
      title="Create this worktree on this machine, uncommitted changes included"
      pending={bring.isPending}
      onClick={() => bring.mutate()}
    />
  );
}

// Mirror is a bring-here followed by a live two-way mirror between the
// new local worktree and the remote one, so it shares the bring
// button's gate and shape. It only exists in the app: the daemon and
// the gateway live in main, and the web loopback refuses the mutation.
function MirrorButton(props: LandingProps) {
  const mirror = useStartMirror(props);
  if (!window.api.isElectron) return null;
  return (
    <ActionButton
      icon={<RefreshCw />}
      label="Mirror here"
      pendingLabel="Mirroring here…"
      title="Create this worktree on this machine and keep the two in sync, every file, both ways"
      pending={mirror.isPending}
      onClick={() => mirror.mutate()}
    />
  );
}

// The footer's landing buttons share one shape: ghost text button, a
// spinner standing in for the icon while the mutation runs.
function ActionButton({
  icon,
  label,
  pendingLabel,
  title,
  pending,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  pendingLabel: string;
  title: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      disabled={pending}
      title={title}
      onClick={onClick}
    >
      {pending ? <Loader2 className="animate-spin" /> : icon}
      {pending ? pendingLabel : label}
    </Button>
  );
}
