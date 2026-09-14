// A running mirror, from the footer button on the copy the mirror
// landed: its state in four figures, anything that needs acting on,
// what it leaves out (editable in place), the thread of what
// happened, and the controls. The same frame as the start dialog, one
// step long. Viewed from another device the dialog is read-only: the
// controls are local by contract.
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
import type { Worktree } from "@shared/schemas";
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
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useMirrorControls,
  useMirrorHistory,
  useSetMirrorIgnores,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { cn } from "@/lib/utils";
import {
  CARD,
  FlowHeader,
  TransplantBody,
  TransplantFooter,
} from "../transplant/TransplantChrome";
import {
  type IgnoreSelection,
  resolveIgnores,
  sameSelection,
  selectionOf,
} from "./ignoreChoice";
import { MirrorIgnorePicker } from "./MirrorIgnorePicker";
import { describeMirror, gitVerdict } from "./mirrorStatus";

export function MirrorManageDialog({
  session,
  worktree,
  onClose,
}: {
  session: MirrorSession;
  // The local copy the session runs on, in the surrounding scope.
  worktree: Worktree;
  onClose: () => void;
}) {
  const { remote, deviceId } = useHostScope();
  const canControl = !remote;
  const hostLabel = useRemoteDeviceLabel(deviceId);
  const peer = useRemoteDeviceLabel(session.deviceId);
  const view = describeMirror(session);
  const controls = useMirrorControls();
  const { armed, trigger } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  const busy =
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
        title={`Mirror with ${peer}`}
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

      <TransplantBody>
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <Stats session={session} />
            <Notice session={session} view={view} canControl={canControl} />
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
      </TransplantBody>

      <TransplantFooter
        note={
          canControl
            ? "Stopping keeps both copies."
            : `Controlled from ${hostLabel}.`
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
                  controls.stop.mutate(session.session, {
                    onSuccess: onClose,
                  }),
                )
              }
            >
              <Square />
              {armed ? "Confirm stop?" : "Stop"}
            </Button>
          </>
        )}
      </TransplantFooter>
    </ModalShell>
  );
}

// Four figures, one glance: how long, how many cycles, how much is
// here, and whether git agrees.
function Stats({ session }: { session: MirrorSession }) {
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
      <Stat label="Cycles">{session.successfulCycles.toLocaleString()}</Stat>
      <Stat label="Files here">{session.local.files.toLocaleString()}</Stat>
      <Stat label="Git" title={session.git?.detail}>
        <StatusDot
          tone={git.tone}
          label={<span className={TONE_TEXT[git.tone]}>{git.label}</span>}
        />
      </Stat>
    </dl>
  );
}

function Stat({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-w-0 rounded-lg bg-muted/40 px-3 py-2 leading-tight"
      title={title}
    >
      <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">
        {children}
      </dd>
    </div>
  );
}

// The thing to act on, when there is one: a halt, an error, a git
// verdict, or the conflicts held still. Nothing when the mirror is
// fine.
function Notice({
  session,
  view,
  canControl,
}: {
  session: MirrorSession;
  view: ReturnType<typeof describeMirror>;
  canControl: boolean;
}) {
  if (view.showConflicts) {
    return (
      <div className="flex items-center gap-2">
        <MirrorConflictsChip
          session={session}
          tone={view.tone}
          label={view.label}
          canReveal={canControl}
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
  worktree: Worktree;
  canControl: boolean;
}) {
  const current = selectionOf(session);
  const [draft, setDraft] = useState<IgnoreSelection | null>(null);
  const selection = draft ?? current;
  // Read only while the gitignored rule shows: it walks the checkout.
  const ignored = useWorktreeIgnoredPaths(worktree.projectId, worktree.id, {
    enabled: selection.mode === "gitignored",
  });
  const setIgnores = useSetMirrorIgnores();
  const dirty = draft !== null && !sameSelection(draft, current);
  const waiting = selection.mode === "gitignored" && ignored.data === undefined;
  const apply = () => {
    if (draft === null) return;
    setIgnores.mutate(
      { session: session.session, ...resolveIgnores(draft, ignored.data) },
      { onSuccess: () => setDraft(null) },
    );
  };
  return (
    <MirrorIgnorePicker
      value={selection}
      onChange={setDraft}
      ignored={ignored}
      worktree={worktree}
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
    </MirrorIgnorePicker>
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
