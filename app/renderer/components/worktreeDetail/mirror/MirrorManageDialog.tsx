// A running mirror, from the footer button on either of its
// worktrees: the pair it keeps in step, anything that needs acting on,
// what it leaves out (editable in place), the thread of what happened,
// and the controls. Stop confirms in place, in the footer, with the
// dialog still behind it: it removes the copy, plainly when the copy is
// known to hold nothing the original lacks, and otherwise as a discard
// that says what is unconfirmed. Mounted under the scope of the device
// RUNNING the session (mirror/MirrorAction.tsx), so every read and
// control here goes to that device: the page it opened from may be that
// device's own, a peer's viewed from here, or the far end's. The
// controls need that device's command grant, like any mutation on a
// peer. Without it the dialog is read-only and says whose switch it is.
import { useState } from "react";
import type { MirrorSession } from "@shigomori/contracts/modules/mirror";
import {
  isHaltedStatus,
  mirrorStopRefusalReason,
  mirrorFilesSettled,
  mirrorStopBlocker,
} from "@shigomori/contracts/modules/mirror";
import { ModalShell } from "@/components/ui/modal-shell";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import {
  useMirrorControls,
  useMirrorHistory,
  useSetMirrorIgnores,
} from "@/hooks/remote/useMirrors";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import {
  type IgnoreSelection,
  modeOf,
  resolveIgnores,
  sameSelection,
  selectionOf,
} from "../flow/ignoreChoice";
import { browseWorktree, LeaveOutPicker } from "../flow/LeaveOutPicker";
import {
  MirrorHistoryListView,
  MirrorIgnoresApplyView,
  MirrorManageDialogView,
  type MirrorNames,
  MirrorPairStripView,
  type StopConfirm,
} from "./MirrorManageDialogView";
import type { MirrorLook } from "./mirrorStatus";

export function MirrorManageDialog({
  session,
  view,
  names,
  revealUnder,
  onClose,
  onStopped,
}: {
  session: MirrorSession;
  view: MirrorLook;
  names: MirrorNames;
  revealUnder: string | undefined;
  onClose: () => void;
  // After a stop, and whether it removed the copy (it keeps it when the
  // original is gone). The opener knows whether its page was that copy.
  onStopped: (removedCopy: boolean) => void;
}) {
  const { canCommand: canControl } = useCommandAccess();
  // The worktree the session runs on, on the runner: the original. Its
  // .gitignore files are the tracked ones both copies hold, so the
  // ignore rule reads off it, and the history thread is keyed by it.
  const worktree = {
    projectId: session.localProjectId,
    id: session.localWorktreeId,
    path: session.localRoot,
  };
  const controls = useMirrorControls();
  const setIgnores = useSetMirrorIgnores();
  const stop = useStopConfirm(controls, session, names, (removedCopy) => {
    onClose();
    onStopped(removedCopy);
  });
  // A session the runner lists as stopping is past its controls: the
  // engine has ended it and the copy is on its way out.
  const busy =
    session.stopping === true ||
    controls.pause.isPending ||
    controls.resume.isPending ||
    controls.stop.isPending ||
    setIgnores.isPending;
  // A halted session takes a resume too: the engine starts its loop
  // again, which is the way out of a halt whose cause was put right.
  const resumable = session.paused || isHaltedStatus(session.status);
  return (
    <ModalShell onClose={onClose} popoverClassName="max-w-3xl">
      <MirrorManageDialogView
        session={session}
        view={view}
        names={names}
        revealUnder={revealUnder}
        canControl={canControl}
        busy={busy}
        resumable={resumable}
        stop={stop}
        onPauseResume={() =>
          (resumable ? controls.resume : controls.pause).mutate(session.session)
        }
        onClose={onClose}
        pair={<PairStrip session={session} names={names} />}
        ignores={
          <Ignores
            session={session}
            worktree={worktree}
            canControl={canControl}
            setIgnores={setIgnores}
          />
        }
        history={<HistoryList localWorktreeId={worktree.id} />}
      />
    </ModalShell>
  );
}

// The stop's confirm, held in the footer. It removes the copy: plainly
// when the copy is known to hold nothing the original lacks, and as a
// discard, saying what is unconfirmed, when that is not known. The
// verdict is read off the session live, so a mirror that catches up
// while the confirm is up turns it back into the plain one (what clears
// it, a conflict's files or a resume, is in the body and the header).
// A refusal from the runner (it looked again at the stop and found the
// copy not in step) stands in for the session's verdict until the
// session moves on from where it was refused.
function useStopConfirm(
  controls: ReturnType<typeof useMirrorControls>,
  session: MirrorSession,
  names: MirrorNames,
  onStopped: (removedCopy: boolean) => void,
): StopConfirm {
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<{
    reason: string;
    at: string;
  } | null>(null);
  const moment = `${session.successfulCycles}:${session.git?.status ?? ""}`;
  const blocker =
    mirrorStopBlocker(session) ??
    (refusal?.at === moment ? refusal.reason : undefined);
  const note =
    blocker === undefined
      ? `Removes the copy on ${names.copy}. It's in step, so nothing is lost.`
      : `Not confirmed in step: ${blocker}. Removing the copy on ${names.copy} now loses anything only it holds.`;
  return {
    confirming,
    blocker,
    note,
    pending: controls.stop.isPending || session.stopping === true,
    ask: () => setConfirming(true),
    cancel: () => setConfirming(false),
    confirm: () =>
      controls.stop.mutate(
        { session, force: blocker !== undefined, copyName: names.copy },
        {
          onSuccess: (result) => onStopped(result?.removedCopy !== false),
          onError: (error) => {
            const reason = mirrorStopRefusalReason(error);
            if (reason !== undefined) setRefusal({ reason, at: moment });
          },
        },
      ),
  };
}

// The pair's two devices, the runner's (this scope's) and the copy's.
function PairStrip({
  session,
  names,
}: {
  session: MirrorSession;
  names: MirrorNames;
}) {
  const { deviceId: runnerDeviceId } = useHostScope();
  return (
    <MirrorPairStripView
      session={session}
      names={names}
      runnerIcon={useDeviceIcon(runnerDeviceId)}
      copyIcon={useDeviceIcon(session.deviceId)}
    />
  );
}

// What stays out, editable in place: change the rule and an Apply
// row appears, since the engine cannot re-configure a live session
// (the host re-opens it). Read off the local copy: its .gitignore
// files are the tracked ones both copies hold, and the picker browses
// the folders that crossed. Only on a pair in step: the re-opened
// session starts with no shared history, so the host refuses it
// otherwise, and the picker says so up front.
function Ignores({
  session,
  worktree,
  canControl,
  setIgnores,
}: {
  session: MirrorSession;
  worktree: { projectId: string; id: string; path: string };
  canControl: boolean;
  setIgnores: ReturnType<typeof useSetMirrorIgnores>;
}) {
  const current = selectionOf(session);
  const [draft, setDraft] = useState<IgnoreSelection | null>(null);
  const selection = draft ?? current;
  // Read only while the gitignored rule shows: it walks the checkout.
  const ignored = useWorktreeIgnoredPaths(worktree.projectId, worktree.id, {
    enabled: selection.base === "gitignored",
  });
  const settled = mirrorFilesSettled(session);
  // A session whose patterns do not read back as its rule (another
  // client's) still takes an Apply, which rewrites it as drawn.
  const dirty =
    draft !== null &&
    (!sameSelection(draft, current) || modeOf(draft) !== session.ignoreMode);
  const waiting = selection.base === "gitignored" && ignored.data === undefined;
  const apply = () => {
    if (draft === null) return;
    setIgnores.mutate(
      { session: session.session, ...resolveIgnores(draft, ignored.data) },
      { onSuccess: () => setDraft(null) },
    );
  };
  return (
    <LeaveOutPicker
      value={selection}
      onChange={setDraft}
      ignored={ignored}
      browse={browseWorktree(worktree)}
      disabled={!canControl || setIgnores.isPending}
    >
      {dirty && (
        <MirrorIgnoresApplyView
          pending={setIgnores.isPending}
          disabled={setIgnores.isPending || waiting || !settled}
          settled={settled}
          onApply={apply}
          onRevert={() => setDraft(null)}
        />
      )}
    </LeaveOutPicker>
  );
}

function HistoryList({ localWorktreeId }: { localWorktreeId: string }) {
  const { data: events, isPending } = useMirrorHistory(localWorktreeId);
  return <MirrorHistoryListView events={events} isPending={isPending} />;
}
