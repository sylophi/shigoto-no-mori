// The remote worktree detail's cross-device actions, the three ways
// to reach work on another machine in one place: its ports ("Ports":
// forward one here, or see what it serves), a live mirror of the
// worktree here ("Mirror here"), or moving it here and deciding what
// becomes of the source ("Transplant"). Text buttons, since the footer
// has room to say what they do. Ports is always there (reading the
// list needs no grant) and is the same button the local page's footer
// carries. The two transfers need command access, a real branch, and
// a local project sharing the repo identity (the handler re-verifies
// that last one). A repo with no identity at all gets a line of
// explanation instead of an empty footer. The peer's primary checkout
// can only be mirrored: a transplant would have to tear the project
// itself down.
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { useState } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { FooterActionButton } from "./FooterActionButton";
import { MirrorDialog } from "./mirror/MirrorDialog";
import { PortsButton } from "./ports/PortsButton";
import { TransplantDialog } from "./transplant/TransplantDialog";

export function RemoteWorktreeActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const { granted } = useCommandAccess();
  const transferable =
    granted && !worktree.detached && isRealBranch(worktree.branch);
  return (
    <>
      <PortsButton worktree={worktree} />
      {transferable && (
        <TransferActions worktree={worktree} project={project} />
      )}
    </>
  );
}

// The two transfers, or the one line that explains their absence.
function TransferActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const localProject = useLocalProjectForIdentity(project.identity);
  // A project git couldn't identify can never match a local one, so no
  // transfer here will ever work. Say so: two controls disappearing
  // without a word reads as a bug, and the cause (the repo, not the
  // app) is fixable by the person looking at it.
  if (project.identity == null) return <NoIdentityNote />;
  // Identified, but nothing on this machine is the same repo. The
  // buttons stay hidden: this one resolves by adding the project here,
  // and the empty projects list already says that.
  if (localProject === undefined) return null;
  return (
    <>
      <MirrorButton
        worktree={worktree}
        project={project}
        sourceIdentity={project.identity}
        localProject={localProject}
      />
      {!worktree.isPrimary && (
        <TransplantButton
          worktree={worktree}
          project={project}
          sourceIdentity={project.identity}
          localProject={localProject}
        />
      )}
    </>
  );
}

// Muted footer text, the shape the read-only note in the same footer
// uses. It truncates on a narrow window, so the title repeats it. The
// branch names spell out DEFAULT_BRANCH_CANDIDATES in
// shared/git/defaultBranch.mts (the renderer bundle cannot import .mts),
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
      <FooterActionButton
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
      <FooterActionButton
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
