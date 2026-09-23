// A running mirror, from the footer button on either of its
// worktrees: its state in four figures, anything that needs acting on,
// what it leaves out (editable in place), the thread of what
// happened, and the controls. The same frame as the start dialog, one
// step long. Mounted under the scope of the device RUNNING the session
// (mirror/MirrorAction.tsx), so every read and control here goes to
// that device: the page it opened from may be that device's own, a
// peer's viewed from here, or the far end's. The controls need that
// device's command grant, like any mutation on a peer. Without it the
// dialog is read-only and says whose switch it is.
import { useState } from "react";
import {
  AlertCircle,
  Check,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Square,
  type LucideIcon,
} from "lucide-react";
import type {
  MirrorEvent,
  MirrorEventKind,
  MirrorSession,
} from "@shared/ipc/modules/mirror";
import {
  isMirrorStopUnconfirmed,
  mirrorCopyOf,
  mirrorStopIsSafe,
} from "@shared/ipc/modules/mirror";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { RelativeDate } from "@/components/ui/relative-date";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import {
  StatusDot,
  type StatusTone,
  TONE_PILL,
  TONE_TEXT,
} from "@/components/ui/status-dot";
import { MirrorConflictsChip } from "@/components/worktreeDetail/MirrorConflicts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useMirrorControls,
  useMirrorHistory,
  useSetMirrorIgnores,
} from "@/hooks/remote/useMirrors";
import { useDeviceName } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { localDeviceId } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CARD, FlowHeader, FlowBody, FlowFooter } from "../flow/FlowChrome";
import {
  type IgnoreSelection,
  modeOf,
  resolveIgnores,
  sameSelection,
  selectionOf,
} from "../flow/ignoreChoice";
import { browseWorktree, LeaveOutPicker } from "../flow/LeaveOutPicker";
import { describeMirror, gitVerdict } from "./mirrorStatus";

export function MirrorManageDialog({
  session,
  otherDeviceId,
  onClose,
  onStopped,
}: {
  session: MirrorSession;
  // The mirror's other party as the page it opened from sees it.
  otherDeviceId: string;
  onClose: () => void;
  // After a stop removed the copy: the opener knows whether the page
  // it sits on was that copy.
  onStopped: () => void;
}) {
  // The scope is the runner's. `remote` says whether that is another
  // machine, which is what the reveal (this machine's Finder) gates
  // on. The controls gate on its grant.
  const { remote, deviceId: runnerDeviceId } = useHostScope();
  const { canCommand: canControl } = useCommandAccess();
  const runner = useDeviceName(runnerDeviceId);
  const other = useDeviceName(otherDeviceId);
  // The worktree the session runs on, on the runner: the copy, or the
  // original when the mirror was started to a peer. Its .gitignore
  // files are the tracked ones both copies hold, so the ignore rule
  // reads off it, and the history thread is keyed by it.
  const worktree = {
    projectId: session.localProjectId,
    id: session.localWorktreeId,
    path: session.localRoot,
  };
  const view = describeMirror(session);
  const controls = useMirrorControls();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // This snapshot drives the WARNING only. The host re-reads the live
  // status and decides, so a refusal it sends escalates to the discard
  // wording here instead of dead-ending on a raw error.
  const [refused, setRefused] = useState(false);
  const discarding = !mirrorStopIsSafe(session.git?.status) || refused;
  // Where the copy a stop removes is, and who keeps the original: on
  // the peer for a mirror started to it, otherwise on the runner.
  // Either may be this machine.
  const copy = mirrorCopyOf(session, runnerDeviceId);
  const keeperDeviceId =
    copy.deviceId === runnerDeviceId ? session.deviceId : runnerDeviceId;
  const copyName = useDeviceName(copy.deviceId);
  const keeper = useDeviceName(keeperDeviceId);
  const copyWhere = copy.deviceId === localDeviceId ? "here" : `on ${copyName}`;
  // A session the runner lists as stopping is past its controls: the
  // engine has ended it and the copy is on its way out.
  const busy =
    session.stopping === true ||
    controls.pause.isPending ||
    controls.resume.isPending ||
    controls.stop.isPending;
  return (
    <ModalShell
      onClose={onClose}
      popoverClassName="flex max-h-[85vh] max-w-3xl flex-col"
    >
      <FlowHeader
        tint={TONE_PILL[view.tone]}
        icon={RefreshCw}
        spin={view.spinning}
        title={`Mirror with ${other}`}
        onClose={onClose}
      >
        <p className="flex min-w-0 items-center gap-1.5">
          <StatusDot
            tone={view.tone}
            label={
              <span className={cn("text-xs font-medium", TONE_TEXT[view.tone])}>
                {view.label}
              </span>
            }
          />
          {view.detail !== "" && view.tone !== "rose" && (
            <span className="min-w-0 truncate">({view.detail})</span>
          )}
        </p>
      </FlowHeader>

      <FlowBody>
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <Stats
              session={session}
              filesLabel={
                runnerDeviceId === localDeviceId
                  ? "Files here"
                  : `Files on ${runner}`
              }
            />
            <Notice session={session} view={view} canReveal={!remote} />
            <Ignores
              session={session}
              worktree={worktree}
              canControl={canControl}
            />
          </div>
          <section className="space-y-2">
            <SectionHeading>History</SectionHeading>
            <HistoryList localWorktreeId={worktree.id} />
          </section>
        </div>
      </FlowBody>

      <FlowFooter
        note={
          !canControl
            ? peerReadOnlyNote(runner)
            : discarding
              ? `Not confirmed in step with ${other}. Stopping removes the copy ${copyWhere}, and anything it holds that ${keeper} has not received goes with it.`
              : `Stopping removes the copy ${copyWhere}. ${keeperDeviceId === localDeviceId ? "This device" : keeper} keeps its own.`
        }
      >
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        {canControl && (
          <>
            {session.paused ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => controls.resume.mutate(session.session)}
              >
                <Play />
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => controls.pause.mutate(session.session)}
              >
                <Pause />
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant={armed ? "destructive" : "outline"}
              aria-pressed={armed}
              disabled={busy}
              onClick={() =>
                trigger(() =>
                  controls.stop.mutate(
                    // The second press is the override, after the
                    // warning has named what goes.
                    { session, force: discarding },
                    {
                      onSuccess: () => {
                        onClose();
                        onStopped();
                      },
                      // The host knew something this page did not.
                      onError: (error) => {
                        if (isMirrorStopUnconfirmed(error)) setRefused(true);
                      },
                    },
                  ),
                )
              }
            >
              <Square />
              {armed
                ? discarding
                  ? "Discard and stop?"
                  : "Confirm stop?"
                : "Stop"}
            </Button>
          </>
        )}
      </FlowFooter>
    </ModalShell>
  );
}

// Four figures, one glance: how long, how many cycles, how much the
// runner's copy holds, and whether git agrees. A paused session
// reports no cycles, no files and git off, because the engine tears
// its scan down while paused. Shown raw that reads as a mirror that
// lost everything, so the three figures say "paused" until it resumes.
function Stats({
  session,
  filesLabel,
}: {
  session: MirrorSession;
  // Names the runner's endpoint, whose file count this is.
  filesLabel: string;
}) {
  const git = gitVerdict(session.git);
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Started">
        {session.createdAt > 0 ? (
          <RelativeDate date={new Date(session.createdAt).toISOString()} />
        ) : (
          "just now"
        )}
      </Stat>
      <Stat label="Cycles" paused={session.paused}>
        {session.successfulCycles.toLocaleString()}
      </Stat>
      <Stat label={filesLabel} paused={session.paused}>
        {session.local.files.toLocaleString()}
      </Stat>
      <Stat label="Git" title={session.git?.detail} paused={session.paused}>
        <StatusDot
          tone={git.tone}
          label={<span className={TONE_TEXT[git.tone]}>{git.label}</span>}
        />
      </Stat>
    </dl>
  );
}

// `paused` swaps the figure for the word: the engine tears its scan
// down while paused and reports zeros, which would read as a mirror
// that lost everything.
function Stat({
  label,
  title,
  paused = false,
  children,
}: {
  label: string;
  title?: string;
  paused?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-w-0 rounded-lg bg-muted/40 px-3 py-2 leading-tight"
      title={title}
    >
      <dt className="text-3xs tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">
        {paused ? (
          <span className="text-muted-foreground">paused</span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

// The thing to act on, when there is one: a halt, an error, a git
// verdict, or the conflicts held still. Nothing when the mirror is
// fine. A conflict reveals in this machine's Finder, so only while the
// runner (whose copy the paths are under) is this machine.
function Notice({
  session,
  view,
  canReveal,
}: {
  session: MirrorSession;
  view: ReturnType<typeof describeMirror>;
  canReveal: boolean;
}) {
  if (view.showConflicts) {
    return (
      <div className="flex items-center gap-2">
        <MirrorConflictsChip
          session={session}
          tone={view.tone}
          label={view.label}
          canReveal={canReveal}
        />
        <span className="text-xs text-muted-foreground">
          held still until one side matches the other
        </span>
      </div>
    );
  }
  if (view.detail === "" || (view.tone !== "rose" && view.tone !== "amber")) {
    return null;
  }
  return (
    <p
      className={cn(
        "rounded-lg px-3 py-2 text-xs break-words whitespace-pre-line select-text",
        TONE_PILL[view.tone],
      )}
    >
      {view.detail}
    </p>
  );
}

// What stays out, editable in place: change the rule and an Apply
// row appears, since the engine cannot re-configure a live session
// (the host re-opens it). Read off the local copy: its .gitignore
// files are the tracked ones both copies hold, and the picker browses
// the folders that crossed.
function Ignores({
  session,
  worktree,
  canControl,
}: {
  session: MirrorSession;
  worktree: { projectId: string; id: string; path: string };
  canControl: boolean;
}) {
  const current = selectionOf(session);
  const [draft, setDraft] = useState<IgnoreSelection | null>(null);
  const selection = draft ?? current;
  // Read only while the gitignored rule shows: it walks the checkout.
  const ignored = useWorktreeIgnoredPaths(worktree.projectId, worktree.id, {
    enabled: selection.base === "gitignored",
  });
  const setIgnores = useSetMirrorIgnores();
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
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={apply}
            disabled={setIgnores.isPending || waiting}
          >
            {setIgnores.isPending ? "Re-opening…" : "Apply"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={setIgnores.isPending}
            onClick={() => setDraft(null)}
          >
            Revert
          </Button>
          <span className="text-xs text-muted-foreground">
            Re-opens the mirror.
          </span>
        </div>
      )}
    </LeaveOutPicker>
  );
}

const EVENT_LOOK: Record<
  MirrorEventKind,
  { icon: LucideIcon; tone: StatusTone; label: string }
> = {
  started: { icon: Play, tone: "emerald", label: "Started" },
  stopped: { icon: Square, tone: "slate", label: "Stopped" },
  paused: { icon: Pause, tone: "slate", label: "Paused" },
  resumed: { icon: Play, tone: "emerald", label: "Resumed" },
  "ignores-changed": { icon: Settings2, tone: "sky", label: "Rule changed" },
  connected: { icon: Check, tone: "emerald", label: "Connected" },
  disconnected: { icon: AlertCircle, tone: "amber", label: "Disconnected" },
  halted: { icon: AlertCircle, tone: "rose", label: "Halted" },
  error: { icon: AlertCircle, tone: "rose", label: "Error" },
  recovered: { icon: Check, tone: "emerald", label: "Recovered" },
  conflict: { icon: AlertCircle, tone: "amber", label: "Conflict" },
  "git-diverged": { icon: GitBranch, tone: "amber", label: "Git diverged" },
  "git-blocked": { icon: GitBranch, tone: "rose", label: "Git blocked" },
  "git-error": { icon: GitBranch, tone: "rose", label: "Git error" },
  "git-synced": { icon: GitBranch, tone: "emerald", label: "Git in step" },
};

function HistoryList({ localWorktreeId }: { localWorktreeId: string }) {
  const { data: events, isPending } = useMirrorHistory(localWorktreeId);
  if (isPending) {
    return (
      <div className={cn(CARD, "space-y-1.5")}>
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    );
  }
  if (events === undefined || events.length === 0) {
    return (
      <p className={cn(CARD, "text-xs text-muted-foreground")}>Nothing yet.</p>
    );
  }
  return (
    <ol className="max-h-96 space-y-2.5 overflow-y-auto text-xs">
      {events.map((event) => (
        <EventRow
          key={`${event.at}:${event.kind}:${event.detail}`}
          event={event}
        />
      ))}
    </ol>
  );
}

function EventRow({ event }: { event: MirrorEvent }) {
  const look = EVENT_LOOK[event.kind];
  return (
    <li className="flex min-w-0 items-start gap-2">
      <StatusDot tone={look.tone} className="mt-[5px]" />
      <div className="min-w-0 flex-1 leading-snug">
        <div className="flex items-baseline gap-2">
          <span className={cn("font-medium", TONE_TEXT[look.tone])}>
            {look.label}
          </span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            <RelativeDate date={new Date(event.at).toISOString()} />
          </span>
        </div>
        {event.detail !== "" && (
          <p className="truncate text-muted-foreground" title={event.detail}>
            {event.detail}
          </p>
        )}
      </div>
    </li>
  );
}
