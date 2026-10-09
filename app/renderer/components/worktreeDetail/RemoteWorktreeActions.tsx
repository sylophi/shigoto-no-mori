// The remote worktree detail's cross-device actions, the ways to reach
// work on another machine in one place: its files ("Files", the same
// button the local footer leads with, on the grant), a live mirror of
// the worktree here ("Mirror here"), or moving it here and deciding
// what becomes of the source ("Transplant", a row of the footer's
// Options popover). Its ports have a section of the page
// (ports/PortsSection.tsx). The running mirror's button, on a
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
// project itself down. The page renders it in two parts, the way it
// does the local footer's (PeerTransferActions.tsx).
import { canForwardPorts } from "@/hooks/remote/usePortForwards";
import { RefreshCw, Shovel } from "lucide-react";
import type { TransferPartProps } from "./PeerTransferActions";
import { OptionActionView } from "./WorktreeOptionsView";
import { isRealBranch, type Project } from "@shigomori/contracts/schemas";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useLocalProjectForIdentity } from "@/hooks/remote/useLocalProjectForIdentity";
import {
  useMirrorHereBlocker,
  useWorktreeMirrorLinks,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { FooterActionButtonView } from "./FooterActionButtonView";
import { NoIdentityNoteView } from "./NoIdentityNoteView";
import { LABEL_RANK } from "./FooterVerbView";
import { MirrorDialog } from "./mirror/MirrorDialog";
import { TransplantDialog } from "./transplant/TransplantDialog";

// The two transfers, or the one line that explains their absence.
export function RemoteTransferActions(props: TransferPartProps) {
  const { worktree, open } = props;
  // The page holds which dialog is open, so an open one outlives the
  // buttons: the grant reads undefined for a moment when the direct
  // link blips, and a run in progress must keep its progress, its
  // cancel and its report rather than vanish mid-run (the local
  // footer's PeerTransferActions holds its dialog the same way).
  const { granted } = useCommandAccess();
  const transferable =
    granted && !worktree.detached && isRealBranch(worktree.branch);
  if (!transferable && open === null) return null;
  return <TransferActions {...props} buttons={transferable} />;
}

// Whether the buttons show: a dialog held open past the grant shows
// alone.
type ButtonsProps = TransferPartProps & { buttons: boolean };

function TransferActions(props: ButtonsProps) {
  const { project, part } = props;
  const localProject = useLocalProjectForIdentity(project.identity);
  // A project git couldn't identify can never match a local one, so no
  // transfer here will ever work. Say so: two controls disappearing
  // without a word reads as a bug, and the cause (the repo, not the
  // app) is fixable by the person looking at it.
  if (project.identity == null) {
    return part === "footer" && <NoIdentityNoteView />;
  }
  // Identified, and either held here or not: with no checkout on this
  // machine the dialogs clone the repo first (over the device link, so
  // a repo with no remote comes too), and say where.
  return (
    <TransferButtons
      {...props}
      sourceIdentity={project.identity}
      localProject={localProject}
    />
  );
}

// Muted footer text, the shape the read-only note in the same footer
// uses. It truncates on a narrow window, and then its tooltip shows it
// whole. The
// branch names spell out DEFAULT_BRANCH_CANDIDATES in
// shared/git/defaultBranch.mts (the renderer bundle cannot import .mts),
// so a change there changes this sentence.
function TransferButtons({
  worktree,
  project,
  part,
  open,
  setOpen,
  buttons,
  sourceIdentity,
  localProject,
}: ButtonsProps & {
  sourceIdentity: string;
  localProject: Project | undefined;
}) {
  const { deviceId } = useHostScope();
  const deviceLabel = useRemoteDeviceLabel(deviceId);
  const mirrored = useWorktreeMirrorLinks(worktree).length > 0;
  const blocker = useMirrorHereBlocker(deviceLabel);
  if (part === "option") {
    // Transplant is destructive on the remote side, so it opens the
    // review dialog: the dialog is the confirmation. Not while
    // mirrored, like the local footer's.
    return (
      buttons &&
      !worktree.isPrimary &&
      !mirrored && (
        <OptionActionView
          icon={<Shovel />}
          label="Transplant"
          description="Move this worktree to this device."
          onClick={() => setOpen("transplant")}
        />
      )
    );
  }
  const dialog = {
    worktree,
    project,
    sourceIdentity,
    localProject,
    sourceDeviceLabel: deviceLabel,
    onClose: () => setOpen(null),
  };
  return (
    <>
      {/* Mirror is the peer's send followed by a live two-way mirror
          between its worktree and the new copy here, both run on the
          peer, which holds the original, asked for through this
          device's own start (which invites them past its switch) and
          driven by the mirror dialog. It only exists in the app: the
          copy lands on this machine, which a browser is not. A mirror
          withdraws the button, not an OPEN dialog: the mirror it
          starts is what withdraws it, and the dialog's last step (the
          report) must stay up. */}
      {buttons && canForwardPorts && !mirrored && (
        <FooterActionButtonView
          rank={LABEL_RANK.mirrorTo}
          icon={<RefreshCw />}
          label="Mirror"
          tip="Keep a live copy of this worktree on this device"
          disabledReason={blocker}
          onClick={() => setOpen("mirror")}
        />
      )}
      {open === "mirror" && <MirrorDialog {...dialog} />}
      {open === "transplant" && <TransplantDialog {...dialog} />}
    </>
  );
}
