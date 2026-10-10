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
import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeftRight,
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
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type {
  MirrorEvent,
  MirrorEventKind,
  MirrorSession,
} from "@shigomori/contracts/modules/mirror";
import { Button } from "../../../primitives/button.tsx";
import { DeviceGlyphView } from "../../shared/DeviceGlyphView.tsx";
import { RelativeDate } from "../../../primitives/relative-date.tsx";
import { SectionHeading } from "../../../primitives/section-heading.tsx";
import { Skeleton } from "../../../primitives/skeleton.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import {
  StatusDot,
  type StatusTone,
  TONE_PILL,
  TONE_TEXT,
} from "../../../primitives/status-dot.tsx";
import { InlineError } from "../../../primitives/inline-error.tsx";
import { MirrorConflictsChipView } from "../MirrorConflictsView.tsx";
import { peerReadOnlyNote } from "../../../lib/commandAccessCopy.ts";
import { pluralize } from "../../../lib/pluralize.ts";
import { cn } from "../../../lib/utils.ts";
import {
  getBrowseLeafSegment,
  normalizeForSubmit,
} from "@shigomori/contracts/projectPaths";
import {
  CARD,
  CARD_NOTE,
  FlowHeaderView,
  FlowBodyView,
  FlowFooterView,
} from "../flow/FlowChromeView.tsx";
import { gitVerdict, type MirrorLook } from "./mirrorStatus.ts";

export type MirrorNames = {
  // The device running the session, which holds the original.
  runner: string;
  // The device holding the copy.
  copy: string;
  // The mirror's other party as the page it opened from sees it.
  other: string;
};

// The stop's confirm, held in the footer (MirrorManageDialog.tsx
// useStopConfirm).
export type StopConfirm = {
  confirming: boolean;
  // Why the copy is not known to be in step, or undefined.
  blocker: string | undefined;
  note: string;
  pending: boolean;
  ask: () => void;
  cancel: () => void;
  confirm: () => void;
};

// A running mirror's dialog content, drawn (MirrorManageDialog.tsx puts
// it in a ModalShell and binds it): the pair, the figures, anything to
// act on, what it leaves out, the history, and the controls.
export function MirrorManageDialogView({
  session,
  view,
  names,
  revealUnder,
  canControl,
  busy,
  resumable,
  stop,
  onPauseResume,
  onClose,
  pair,
  ignores,
  history,
}: {
  session: MirrorSession;
  view: MirrorLook;
  names: MirrorNames;
  revealUnder: string | undefined;
  // Whether the runner takes commands from here.
  canControl: boolean;
  busy: boolean;
  // Paused or halted: the control resumes rather than pauses.
  resumable: boolean;
  stop: StopConfirm;
  onPauseResume: () => void;
  onClose: () => void;
  pair: ReactNode;
  ignores: ReactNode;
  history: ReactNode;
}) {
  return (
    <>
      <FlowHeaderView
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
              <SimpleTooltip whenTruncated tip={view.detail}>
                <span className="min-w-0 truncate">
                  <span aria-hidden>· </span>
                  {view.detail}
                </span>
              </SimpleTooltip>
            )}
        </p>
      </FlowHeaderView>

      <FlowBodyView>
        <div className="grid gap-5 @min-[48rem]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <div className="space-y-2">
              {pair}
              <Facts session={session} />
            </div>
            <Notice
              session={session}
              view={view}
              names={names}
              revealUnder={revealUnder}
            />
            {ignores}
          </div>
          <section className="space-y-2">
            <SectionHeading>History</SectionHeading>
            {history}
          </section>
        </div>
      </FlowBodyView>

      {stop.confirming ? (
        <FlowFooterView
          note={
            <span
              className={cn(
                stop.blocker !== undefined &&
                  "text-amber-700 dark:text-amber-300",
              )}
            >
              {stop.note}
            </span>
          }
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={stop.pending}
            onClick={stop.cancel}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant={stop.blocker === undefined ? "default" : "destructive"}
            disabled={stop.pending}
            onClick={stop.confirm}
          >
            {stop.pending && <Loader2 className="animate-spin" />}
            {stop.pending
              ? "Stopping…"
              : stop.blocker === undefined
                ? "Stop and remove the copy"
                : "Remove the copy anyway"}
          </Button>
        </FlowFooterView>
      ) : (
        <FlowFooterView
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
                onClick={onPauseResume}
              >
                {resumable ? <Play /> : <Pause />}
                {resumable ? "Resume" : "Pause"}
              </Button>
              <Button
                size="sm"
                variant="outline-destructive"
                disabled={busy}
                onClick={stop.ask}
              >
                <Square />
                Stop mirroring
              </Button>
            </>
          )}
        </FlowFooterView>
      )}
    </>
  );
}

// The two worktrees the mirror pairs, side by side: the original on
// the device running the session, the copy on its peer. A stop removes
// the copy, so which is which is the first thing on the page.
export function MirrorPairStripView({
  session,
  names,
  runnerIcon,
  copyIcon,
}: {
  session: MirrorSession;
  names: MirrorNames;
  runnerIcon: DeviceIcon;
  copyIcon: DeviceIcon;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
      <PairEnd
        icon={runnerIcon}
        name={names.runner}
        side="original"
        path={session.localRoot}
      />
      <SimpleTooltip tip="Kept in step both ways">
        <ArrowLeftRight
          aria-label="Kept in step both ways"
          className="size-4 text-muted-foreground"
        />
      </SimpleTooltip>
      <PairEnd
        icon={copyIcon}
        name={names.copy}
        side="copy"
        path={session.remoteRoot}
        align="end"
      />
    </div>
  );
}

function PairEnd({
  icon,
  name,
  side,
  path,
  align = "start",
}: {
  icon: DeviceIcon;
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
        <DeviceGlyphView
          icon={icon}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <SimpleTooltip whenTruncated tip={name}>
          <span className="truncate">{name}</span>
        </SimpleTooltip>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {side}
        </span>
      </span>
      {/* The folder alone: the two paths sit on two machines, and
          shortened to fit they read as noise. The tooltip has it whole. */}
      <SimpleTooltip tip={path}>
        <span className="max-w-full min-w-0 truncate font-mono text-2xs text-muted-foreground">
          {getBrowseLeafSegment(normalizeForSubmit(path))}
        </span>
      </SimpleTooltip>
    </div>
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
  names,
  revealUnder,
}: {
  session: MirrorSession;
  view: MirrorLook;
  names: MirrorNames;
  revealUnder: string | undefined;
}) {
  if (view.showConflicts) {
    return (
      <div className="flex items-center gap-2">
        <MirrorConflictsChipView
          session={session}
          tone={view.tone}
          label={view.label}
          names={names}
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

// The Apply row under a changed rule: the engine cannot re-configure a
// live session, so applying re-opens it, and only on a pair in step.
export function MirrorIgnoresApplyView({
  pending,
  disabled,
  settled,
  onApply,
  onRevert,
}: {
  pending: boolean;
  disabled: boolean;
  // In step: the host refuses a re-open otherwise.
  settled: boolean;
  onApply: () => void;
  onRevert: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onApply} disabled={disabled}>
        {pending && <Loader2 className="animate-spin" />}
        {pending ? "Re-opening…" : "Apply"}
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onRevert}>
        Revert
      </Button>
      <span className="text-xs text-muted-foreground">
        {settled
          ? "Re-opens the mirror."
          : "Can change once the mirror is running and in step."}
      </span>
    </div>
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

export function MirrorHistoryListView({
  events,
  isPending,
}: {
  events: readonly MirrorEvent[] | undefined;
  isPending: boolean;
}) {
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
