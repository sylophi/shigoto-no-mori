// The remote worktree detail's cross-device actions, the ways to reach
// work on another machine in one place: its files ("Files", the same
// button the local footer leads with, on the grant), a live mirror of
// the worktree here ("Mirror here"), or moving it here and deciding
// what becomes of the source ("Transplant"). Its ports have a section
// of the page (ports/PortsSection.tsx). Text buttons, since the footer
// has room to say what they do. The running mirror's button, on a
// worktree already part of one (mirror/MirrorAction.tsx), stands in
// for "Mirror here": a worktree holds one mirror, the rule the local
// footer's "Mirror to…" follows. Files and that button lead the footer
// on either page (WorktreeDetailInner.tsx), and this file adds the
// transfers. The two transfers need command access, a real branch, and
// a repo identity to match a local project by (the handler re-verifies
// the match). No local project sharing it is not a stop: the dialogs
// clone the repo here first. A repo with no identity at all gets a
// line of explanation instead of an empty footer. The peer's primary
// checkout can only be mirrored: a transplant would have to tear the
// project itself down.
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { useState } from "react";
import { RefreshCw, Shovel } from "lucide-react";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import {
  useMirrorHereBlocker,
  useWorktreeMirrorLinks,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FooterActionButton } from "./FooterActionButton";
import { LABEL_RANK } from "./footerFit";
import { MirrorDialog } from "./mirror/MirrorDialog";
import { TransplantDialog } from "./transplant/TransplantDialog";

// The two transfers, or the one line that explains their absence.
export function RemoteTransferActions({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  const { granted } = useCommandAccess();
  // Which dialog is open, held here so an open one outlives the
  // buttons: the grant reads undefined for a moment when the direct
  // link blips, and a run in progress must keep its progress, its
  // cancel and its report rather than vanish mid-run (the local
  // footer's PeerTransferActions holds its dialog the same way).
  const [open, setOpen] = useState<OpenDialog>(null);
  const transferable =
    granted && !worktree.detached && isRealBranch(worktree.branch);
  return (
    (transferable || open !== null) && (
      <TransferActions
        worktree={worktree}
        project={project}
        buttons={transferable}
        open={open}
        setOpen={setOpen}
      />
    )
  );
}

type OpenDialog = "mirror" | "transplant" | null;
type DialogState = {
  // Whether the buttons show: a dialog held open past the grant shows
  // alone.
  buttons: boolean;
  open: OpenDialog;
  setOpen: (open: OpenDialog) => void;
};

function TransferActions({
  worktree,
  project,
  ...dialogState
}: {
  worktree: Worktree;
  project: Project;
} & DialogState) {
  const localProject = useLocalProjectForIdentity(project.identity);
  // A project git couldn't identify can never match a local one, so no
  // transfer here will ever work. Say so: two controls disappearing
  // without a word reads as a bug, and the cause (the repo, not the
  // app) is fixable by the person looking at it.
  if (project.identity == null) return <NoIdentityNote />;
  // Identified, and either held here or not: with no checkout on this
  // machine the dialogs clone the repo first (over the device link, so
  // a repo with no remote comes too), and say where.
  return (
    <TransferButtons
      worktree={worktree}
      project={project}
      sourceIdentity={project.identity}
      localProject={localProject}
      {...dialogState}
    />
  );
}

// Muted footer text, the shape the read-only note in the same footer
// uses. It truncates on a narrow window, and then its tooltip shows it
// whole. The
// branch names spell out DEFAULT_BRANCH_CANDIDATES in
// shared/git/defaultBranch.mts (the renderer bundle cannot import .mts),
// so a change there changes this sentence.
const NO_IDENTITY_NOTE =
  "No shared identity for this repo (no common remote, and no main, master, dev or remote HEAD branch), so it can't be mirrored or transplanted.";

function NoIdentityNote() {
  return (
    <SimpleTooltip whenTruncated tip={NO_IDENTITY_NOTE}>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {NO_IDENTITY_NOTE}
      </span>
    </SimpleTooltip>
  );
}

function TransferButtons({
  worktree,
  project,
  sourceIdentity,
  localProject,
  buttons,
  open,
  setOpen,
}: {
  worktree: Worktree;
  project: Project;
  sourceIdentity: string;
  localProject: Project | undefined;
} & DialogState) {
  const { deviceId } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const mirrored = useWorktreeMirrorLinks(worktree).length > 0;
  const blocker = useMirrorHereBlocker(deviceLabel);
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    localProject,
    sourceDeviceLabel: deviceLabel,
  };
  return (
    <>
      {/* Mirror is the peer's send followed by a live two-way mirror
          between its worktree and the new copy here, both run on the
          peer, which holds the original, asked for through this
          device's own start (which invites them past its switch) and
          driven by the mirror dialog. It only exists in the app: the copy lands on this
          machine, which a browser is not. A
          mirror withdraws the button, not an OPEN dialog: the mirror it
          starts is what withdraws it, and the dialog's last step (the
          report) must stay up. */}
      {buttons && canForwardPorts && !mirrored && (
        <FooterActionButton
          rank={LABEL_RANK.mirrorTo}
          icon={<RefreshCw />}
          label="Mirror"
          tip="Keep a live copy of this worktree on this device"
          disabledReason={blocker}
          onClick={() => setOpen("mirror")}
        />
      )}
      {open === "mirror" && (
        <MirrorDialog {...dialog} onClose={() => setOpen(null)} />
      )}
      {/* Transplant is destructive on the remote side, so it opens the
          review dialog instead of firing on a double-click: the dialog
          is the confirmation. */}
      {/* Not while mirrored, like the local footer's. */}
      {buttons && !worktree.isPrimary && !mirrored && (
        <FooterActionButton
          rank={LABEL_RANK.transplant}
          icon={<Shovel />}
          label="Transplant"
          tip="Move this worktree to this device"
          onClick={() => setOpen("transplant")}
        />
      )}
      {open === "transplant" && (
        <TransplantDialog {...dialog} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
