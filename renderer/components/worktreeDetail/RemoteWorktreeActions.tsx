// The remote worktree detail's cross-device actions: keep a live
// mirror of the worktree here ("Mirror here"), or move it here and
// decide what becomes of the source ("Transplant"). Text buttons,
// since the footer has room to say what they do. Renders nothing
// unless the caller holds command access, the branch is real, and a
// local project shares the repo identity (the handler re-verifies that
// last one), except that a repo with no identity at all gets a line of
// explanation instead of an empty footer.
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { type ReactNode, useState } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { MirrorDialog } from "./mirror/MirrorDialog";
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
    !isRealBranch(worktree.branch)
  ) {
    return null;
  }
  // A project git couldn't identify can never match a local one, so no
  // button here will ever work. Say so: two controls disappearing
  // without a word reads as a bug, and the cause (the repo, not the
  // app) is fixable by the person looking at it.
  if (project.identity == null) return <NoIdentityNote />;
  // Identified, but nothing on this machine is the same repo. The
  // buttons stay hidden: this one resolves by adding the project here,
  // and the empty projects list already says that.
  if (localProject === undefined) return null;
  return (
    <div className="flex items-center gap-1">
      <MirrorButton
        worktree={worktree}
        project={project}
        sourceIdentity={project.identity}
        localProject={localProject}
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

// Muted footer text, the shape the read-only note in the same footer
// uses. It truncates on a narrow window, so the title repeats it. The
// branch names spell out DEFAULT_BRANCH_CANDIDATES in
// shared/defaultBranch.mts (the renderer bundle cannot import .mts),
// so a change there changes this sentence.
const NO_IDENTITY_NOTE =
  "No shared identity for this repo (no common remote, and no main, master, dev or remote HEAD branch), so it can't be mirrored or transplanted.";

function NoIdentityNote() {
  return (
    <span
      className="min-w-0 truncate text-xs text-muted-foreground"
      title={NO_IDENTITY_NOTE}
    >
      {NO_IDENTITY_NOTE}
    </span>
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
        title="Move this worktree here"
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

// Mirror is a pull followed by a live two-way mirror between the new
// local worktree and the remote one, driven by the mirror dialog. It
// only exists in the app: the daemon and the gateway live in main, and
// the web loopback refuses the mutation.
function MirrorButton({
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
  if (!canForwardPorts) return null;
  return (
    <>
      <ActionButton
        icon={<RefreshCw />}
        label="Mirror here"
        title="Keep a live copy of this worktree here"
        onClick={() => setOpen(true)}
      />
      {open && (
        <MirrorDialog
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

// The footer's two buttons share one shape: a ghost text button that
// opens a dialog.
function ActionButton({
  icon,
  label,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="shrink-0 text-muted-foreground hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      {icon}
      {label}
    </Button>
  );
}
