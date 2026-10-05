// A running mirror, from the footer button on either of its
// worktrees: its state in three figures, anything that needs acting
// on, what it leaves out (editable in place), the thread of what
// happened, and the controls. Stop is a step of its own in the same
// frame, which removes the copy: one confirm when the copy is known to
// hold nothing the original lacks, and otherwise what is unconfirmed,
// what clears it, and the discard. Mounted under the scope of the device RUNNING the
// session (mirror/MirrorAction.tsx), so every read and control here
// goes to that device: the page it opened from may be that device's
// own, a peer's viewed from here, or the far end's. The controls need
// that device's command grant, like any mutation on a peer. Without it
// the dialog is read-only and says whose switch it is.
import { useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  FileWarning,
  Check,
  GitBranch,
  Loader2,
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
  isHaltedStatus,
  isMirrorStopUnconfirmed,
  mirrorFilesSettled,
  mirrorStopBlocker,
} from "@shared/ipc/modules/mirror";
import { errorMessageOf } from "@shared/errors";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { RelativeDate } from "@/components/ui/relative-date";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  StatusDot,
  type StatusTone,
  TONE_PILL,
  TONE_TEXT,
} from "@/components/ui/status-dot";
import { InlineError } from "@/components/ui/inline-error";
import { MirrorConflictsChip } from "@/components/worktreeDetail/MirrorConflicts";
import { useCommandAccess } from "@/hooks/remote/useCommandAccess";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import {
  useMirrorControls,
  useMirrorHistory,
  useSetMirrorIgnores,
} from "@/hooks/remote/useMirrors";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  CARD,
  CARD_NOTE,
  FlowHeader,
  FlowBody,
  FlowFooter,
} from "../flow/FlowChrome";
import {
  type IgnoreSelection,
  modeOf,
  resolveIgnores,
  sameSelection,
  selectionOf,
} from "../flow/ignoreChoice";
import { browseWorktree, LeaveOutPicker } from "../flow/LeaveOutPicker";
import { describeMirror, gitVerdict } from "./mirrorStatus";

type MirrorNames = {
  // The device running the session, which holds the original.
  runner: string;
  // The device holding the copy.
  copy: string;
  // The mirror's other party as the page it opened from sees it.
  other: string;
};

export function MirrorManageDialog({
  session,
  view,
  names,
  sides,
  revealUnder,
  onClose,
  onStopped,
}: {
  session: MirrorSession;
  view: ReturnType<typeof describeMirror>;
  names: MirrorNames;
  sides: { original: string; copy: string };
  revealUnder: string | undefined;
  onClose: () => void;
  // After a stop, which removed the copy. The opener knows whether the
  // page it sits on was that copy.
  onStopped: () => void;
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
  const [stepping, setStepping] = useState<"manage" | "stop">("manage");
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
      <FlowHeader
        tint={TONE_PILL[view.tone]}
        icon={RefreshCw}
        spin={view.spinning}
        title={`Mirror with ${names.other}`}
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
          {/* Trouble is spelled out in the body (Notice), so the header
              carries only the quiet lifecycle line. */}
          {view.detail !== "" &&
            view.tone !== "rose" &&
            view.tone !== "amber" && (
              <span className="min-w-0 truncate">
                <span aria-hidden>· </span>
                {view.detail}
              </span>
            )}
        </p>
      </FlowHeader>

      {stepping === "stop" ? (
        <StopStep
          session={session}
          names={names}
          sides={sides}
          revealUnder={revealUnder}
          onBack={() => setStepping("manage")}
          onStopped={() => {
            onClose();
            onStopped();
          }}
        />
      ) : (
        <>
          <FlowBody>
            <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <div className="flex min-w-0 flex-col gap-5">
                <div className="space-y-2">
                  <PairStrip session={session} names={names} />
                  <Facts session={session} />
                </div>
                <Notice
                  session={session}
                  view={view}
                  sides={sides}
                  revealUnder={revealUnder}
                />
                <Ignores
                  session={session}
                  worktree={worktree}
                  canControl={canControl}
                  setIgnores={setIgnores}
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
                ? peerReadOnlyNote(names.runner)
                : session.stopping === true
                  ? `Removing the copy on ${names.copy}…`
                  : undefined
            }
          >
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
            {canControl && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    (resumable ? controls.resume : controls.pause).mutate(
                      session.session,
                    )
                  }
                >
                  {resumable ? <Play /> : <Pause />}
                  {resumable ? "Resume" : "Pause"}
                </Button>
                <Button
                  size="sm"
                  variant="outline-destructive"
                  disabled={busy}
                  onClick={() => setStepping("stop")}
                >
                  <Square />
                  Stop mirroring…
                </Button>
              </>
            )}
          </FlowFooter>
        </>
      )}
    </ModalShell>
  );
}

// The stop removes the copy. When the copy is known to hold nothing
// the original lacks, that is one confirm. When it is not known, the
// step says what is unconfirmed and what clears it, and reads the
// session live: the mirror catching up while it is open turns it back
// into the plain confirm. Removing anyway stays, as the discard it is.
// A refusal from the runner (it looked again at the stop and found the
// copy not in step) stands in for the session's verdict until the
// session moves on from where it was refused.
function StopStep({
  session,
  names,
  sides,
  revealUnder,
  onBack,
  onStopped,
}: {
  session: MirrorSession;
  names: MirrorNames;
  sides: { original: string; copy: string };
  revealUnder: string | undefined;
  onBack: () => void;
  onStopped: () => void;
}) {
  const controls = useMirrorControls();
  const [refusal, setRefusal] = useState<{
    reason: string;
    at: string;
  } | null>(null);
  // What the session looked like at a refusal: once it moves on, the
  // session's own verdict is the newer word.
  const moment = `${session.successfulCycles}:${session.git?.status ?? ""}`;
  const blocker =
    mirrorStopBlocker(session) ??
    (refusal?.at === moment ? refusal.reason : undefined);
  const pending = controls.stop.isPending || session.stopping === true;
  const stop = () => {
    controls.stop.mutate(
      { session, force: blocker !== undefined, copyName: names.copy },
      {
        onSuccess: onStopped,
        onError: (error) => {
          if (isMirrorStopUnconfirmed(error)) {
            setRefusal({
              reason: refusalReason(errorMessageOf(error)),
              at: moment,
            });
          }
        },
      },
    );
  };
  return (
    <>
      <FlowBody>
        {blocker === undefined ? (
          <p className="text-sm">
            This removes the copy on {names.copy}. It&rsquo;s in step, so
            nothing is lost, and {names.runner} keeps the original.
          </p>
        ) : (
          <div className="space-y-3">
            <div
              className={cn(
                "space-y-2 rounded-lg px-3 py-2.5 text-sm",
                TONE_PILL.amber,
              )}
            >
              <p className="font-medium">Not confirmed in step: {blocker}.</p>
              <StopAdvice
                session={session}
                names={names}
                sides={sides}
                revealUnder={revealUnder}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Removing the copy on {names.copy} now loses anything only it
              holds.
            </p>
          </div>
        )}
      </FlowBody>
      <FlowFooter>
        <Button variant="ghost" size="sm" disabled={pending} onClick={onBack}>
          <ArrowLeft />
          Back
        </Button>
        <Button
          size="sm"
          variant={blocker === undefined ? "default" : "destructive"}
          disabled={pending}
          onClick={stop}
        >
          {pending && <Loader2 className="animate-spin" />}
          {pending
            ? "Stopping…"
            : blocker === undefined
              ? "Stop mirroring"
              : "Remove the copy anyway"}
        </Button>
      </FlowFooter>
    </>
  );
}

// What clears the stop's warning, by what is holding it up, with the
// one control that does it when there is one: a paused or halted
// mirror resumes, a conflict lists its paths.
function StopAdvice({
  session,
  names,
  sides,
  revealUnder,
}: {
  session: MirrorSession;
  names: MirrorNames;
  sides: { original: string; copy: string };
  revealUnder: string | undefined;
}) {
  const controls = useMirrorControls();
  const conflicts = session.conflicts.length + session.excludedConflicts;
  if (session.paused || isHaltedStatus(session.status)) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span>Resume it and it catches up.</span>
        <Button
          size="xs"
          variant="outline"
          disabled={controls.resume.isPending}
          onClick={() => controls.resume.mutate(session.session)}
        >
          <Play />
          Resume
        </Button>
      </div>
    );
  }
  if (!session.local.connected || !session.remote.connected) {
    return <p>It catches up once {names.copy} is back.</p>;
  }
  if (conflicts > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Make {conflicts === 1 ? "it" : "each"} match on one side, and the
          mirror moves again.
        </span>
        <MirrorConflictsChip
          session={session}
          tone="amber"
          icon={FileWarning}
          label={conflicts === 1 ? "See the file" : "See the files"}
          sides={sides}
          revealUnder={revealUnder}
        />
      </div>
    );
  }
  if (session.git?.status === "diverged") {
    return (
      <p>
        Both sides committed since they last agreed. Put one side back on the
        commit they shared, and git follows again.
      </p>
    );
  }
  if (
    (session.git?.status === "blocked" || session.git?.status === "error") &&
    session.git.detail !== ""
  ) {
    const { detail } = session.git;
    return <p>{detail.charAt(0).toUpperCase() + detail.slice(1)}.</p>;
  }
  return <p>It&rsquo;s catching up. This updates by itself.</p>;
}

// The runner's reason out of its refusal ("<marker>: <reason>, so the
// copy may hold…"), or the whole message when it is not that shape.
function refusalReason(message: string): string {
  const match = /: ([^,]+), so the copy/.exec(message);
  return match?.[1] ?? message;
}

// The two worktrees the mirror pairs, side by side: the original on
// the device running the session, the copy on its peer. A stop removes
// the copy, so which is which is the first thing on the page.
function PairStrip({
  session,
  names,
}: {
  session: MirrorSession;
  names: MirrorNames;
}) {
  const { deviceId: runnerDeviceId } = useHostScope();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
      <PairEnd
        deviceId={runnerDeviceId}
        name={names.runner}
        side="original"
        path={session.localRoot}
      />
      <ArrowLeftRight
        aria-label="kept in step both ways"
        className="size-4 text-muted-foreground"
      />
      <PairEnd
        deviceId={session.deviceId}
        name={names.copy}
        side="copy"
        path={session.remoteRoot}
        align="end"
      />
    </div>
  );
}

function PairEnd({
  deviceId,
  name,
  side,
  path,
  align = "start",
}: {
  deviceId: string;
  name: string;
  side: "original" | "copy";
  path: string;
  align?: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 leading-tight",
        align === "end" && "items-end text-right",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <DeviceGlyph
          icon={useDeviceIcon(deviceId)}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {side}
        </span>
      </span>
      {/* The folder alone: the two paths sit on two machines, and
          shortened to fit they read as noise. The tooltip has it whole. */}
      <SimpleTooltip tip={path}>
        <span className="max-w-full min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {folderOf(path)}
        </span>
      </SimpleTooltip>
    </div>
  );
}

// The last segment of a path, either separator.
function folderOf(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

// The mirror's figures in one quiet line under the pair: how long it
// has run, how much the original holds, whether git agrees (its detail
// on hover). A paused session reports no files and git off, because
// the engine tears its scan down while paused, so the line says
// "paused" instead of figures that read as a mirror that lost
// everything.
function Facts({ session }: { session: MirrorSession }) {
  const git = gitVerdict(session.git);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-muted-foreground">
      <span>
        Started{" "}
        {session.createdAt > 0 ? (
          <RelativeDate date={new Date(session.createdAt).toISOString()} />
        ) : (
          "just now"
        )}
      </span>
      <span aria-hidden>·</span>
      {session.paused ? (
        <span>paused</span>
      ) : (
        <>
          <span className="tabular-nums">
            {pluralize(session.local.files, "file")}
          </span>
          <span aria-hidden>·</span>
          <SimpleTooltip tip={session.git?.detail || undefined}>
            <span>
              <StatusDot
                tone={git.tone}
                className="text-xs"
                label={`Git ${git.label.toLowerCase()}`}
              />
            </span>
          </SimpleTooltip>
        </>
      )}
    </p>
  );
}

// The thing to act on, when there is one: a halt, an error, a git
// verdict, a lost link, or the conflicts held still. Nothing when the
// mirror is fine. A conflict reveals in this machine's Finder, under
// whichever side this machine holds.
function Notice({
  session,
  view,
  sides,
  revealUnder,
}: {
  session: MirrorSession;
  view: ReturnType<typeof describeMirror>;
  sides: { original: string; copy: string };
  revealUnder: string | undefined;
}) {
  if (view.showConflicts) {
    return (
      <div className="flex items-center gap-2">
        <MirrorConflictsChip
          session={session}
          tone={view.tone}
          label={view.label}
          sides={sides}
          revealUnder={revealUnder}
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={apply}
            disabled={setIgnores.isPending || waiting || !settled}
          >
            {setIgnores.isPending && <Loader2 className="animate-spin" />}
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
            {settled
              ? "Re-opens the mirror."
              : "Can change once the mirror is running and in step."}
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
  "git-blocked": { icon: GitBranch, tone: "amber", label: "Git waiting" },
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
    return <p className={CARD_NOTE}>Nothing yet.</p>;
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
          <InlineError
            message={event.detail}
            title={look.label}
            className="text-muted-foreground"
          />
        )}
      </div>
    </li>
  );
}
