// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. Two shapes, both quiet when there is
// nothing to say:
//   - this worktree is the LOCAL copy of a peer's worktree (a session
//     this device runs): status, conflicts and problems, plus pause /
//     resume / stop when viewed on the machine that runs it.
//   - this worktree is being mirrored BY peers (streams this device
//     serves): one chip per peer.
// Status tones use the four semantic families only: emerald for a
// settled live mirror, sky while cycles run, amber for conflicts and
// reconnects, rose for a halt or an error.
import { Loader2, Pause, Play, RefreshCw, Square } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { MirrorSession, MirrorStatus } from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useMirrorControls,
  useWorktreeMirror,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { cn } from "@/lib/utils";

type Tone = "emerald" | "sky" | "amber" | "rose" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  emerald: "text-emerald-500",
  sky: "text-sky-500",
  amber: "text-amber-500",
  rose: "text-rose-500",
  muted: "text-muted-foreground",
};

const BUSY: ReadonlySet<MirrorStatus> = new Set([
  "scanning",
  "waiting-for-rescan",
  "reconciling",
  "staging-local",
  "staging-remote",
  "transitioning",
  "saving",
]);

// One line of truth about a session, worst news first: a halt or a
// stored error, then conflicts, then problems, then the ordinary
// lifecycle.
function describe(session: MirrorSession): {
  tone: Tone;
  label: string;
  detail: string;
  spinning: boolean;
} {
  const problems =
    session.local.problems.length +
    session.remote.problems.length +
    session.local.excludedProblems +
    session.remote.excludedProblems;
  const conflicts = session.conflicts.length + session.excludedConflicts;
  if (session.paused) {
    return {
      tone: "muted",
      label: "Mirror paused",
      detail: "",
      spinning: false,
    };
  }
  if (session.status.startsWith("halted-")) {
    return {
      tone: "rose",
      label: "Mirror halted",
      detail: session.statusText,
      spinning: false,
    };
  }
  if (session.lastError) {
    return {
      tone: "rose",
      label: "Mirror error",
      detail: session.lastError,
      spinning: false,
    };
  }
  // The git half's verdict outranks file-level news: a diverged or
  // blocked branch is the thing to act on.
  if (session.git?.status === "diverged") {
    return {
      tone: "amber",
      label: "Git diverged",
      detail: `${session.git.detail}. Neither side is changed until you reconcile.`,
      spinning: false,
    };
  }
  if (session.git?.status === "blocked") {
    return {
      tone: "rose",
      label: "Git blocked",
      detail: session.git.detail,
      spinning: false,
    };
  }
  if (session.git?.status === "error") {
    return {
      tone: "rose",
      label: "Git follow error",
      detail: session.git.detail,
      spinning: false,
    };
  }
  if (conflicts > 0) {
    return {
      tone: "amber",
      label: `${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`,
      detail: session.conflicts
        .map((c) => c.root)
        .slice(0, 5)
        .join("\n"),
      spinning: false,
    };
  }
  if (problems > 0) {
    return {
      tone: "rose",
      label: `${problems} mirror ${problems === 1 ? "problem" : "problems"}`,
      detail: [...session.local.problems, ...session.remote.problems]
        .map((p) => `${p.path}: ${p.error}`)
        .slice(0, 5)
        .join("\n"),
      spinning: false,
    };
  }
  if (
    session.status === "connecting-local" ||
    session.status === "connecting-remote" ||
    session.status === "disconnected"
  ) {
    return {
      tone: "amber",
      label: "Mirror reconnecting",
      detail: session.statusText,
      spinning: true,
    };
  }
  if (BUSY.has(session.status) || session.git?.status === "following") {
    return {
      tone: "sky",
      label: "Mirror syncing",
      detail:
        session.git?.status === "following"
          ? `git ${session.git.detail}`
          : session.statusText,
      spinning: true,
    };
  }
  return {
    tone: "emerald",
    label: "Mirror live",
    detail: `${session.local.files} files, ${session.successfulCycles} cycles`,
    spinning: false,
  };
}

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

function Chip({
  tone,
  icon: Icon,
  label,
  title,
  spinning = false,
  onClick,
  pending = false,
}: {
  tone: Tone;
  icon: IconType;
  label: string;
  title: string;
  spinning?: boolean;
  onClick?: () => void;
  pending?: boolean;
}) {
  const DisplayIcon = pending ? Loader2 : Icon;
  const className = cn(
    "tabular inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs",
    TONE_TEXT[tone],
    onClick !== undefined &&
      "transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
  );
  const body = (
    <>
      <DisplayIcon
        aria-hidden
        className={cn("size-3.5", (spinning || pending) && "animate-spin")}
      />
      {label}
    </>
  );
  if (onClick === undefined) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={onClick}
      disabled={pending}
    >
      {body}
    </button>
  );
}

function PeerName({ deviceId }: { deviceId: string }) {
  const label = useRemoteDeviceLabel(deviceId);
  return <>{label || "another device"}</>;
}

export function MirrorPill({ worktree }: { worktree: Worktree }) {
  const { remote } = useHostScope();
  const { session, serving } = useWorktreeMirror(worktree);
  const controls = useMirrorControls();
  if (session === undefined && serving.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {session !== undefined && (
        <SessionLine
          session={session}
          canControl={!remote}
          controls={controls}
        />
      )}
      {serving.map((stream) => (
        <Chip
          key={stream.connId}
          tone="emerald"
          icon={RefreshCw}
          label="Mirrored elsewhere"
          title="A peer keeps a live copy of this worktree"
        />
      ))}
      {serving.length > 0 && (
        <span className="text-muted-foreground">
          to{" "}
          {serving.map((stream, index) => (
            <span key={stream.connId}>
              {index > 0 && ", "}
              <PeerName deviceId={stream.peerDeviceId} />
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function SessionLine({
  session,
  canControl,
  controls,
}: {
  session: MirrorSession;
  canControl: boolean;
  controls: ReturnType<typeof useMirrorControls>;
}) {
  const view = describe(session);
  return (
    <>
      <Chip
        tone={view.tone}
        icon={RefreshCw}
        label={view.label}
        title={view.detail || view.label}
        spinning={view.spinning}
      />
      <span className="text-muted-foreground">
        with <PeerName deviceId={session.deviceId} />
      </span>
      {canControl && (
        <>
          {session.paused ? (
            <Chip
              tone="muted"
              icon={Play}
              label="Resume"
              title="Resume mirroring"
              pending={controls.resume.isPending}
              onClick={() => controls.resume.mutate(session.session)}
            />
          ) : (
            <Chip
              tone="muted"
              icon={Pause}
              label="Pause"
              title="Pause mirroring (files stay where they are)"
              pending={controls.pause.isPending}
              onClick={() => controls.pause.mutate(session.session)}
            />
          )}
          <Chip
            tone="muted"
            icon={Square}
            label="Stop"
            title="Stop mirroring. Both copies stay as they are."
            pending={controls.stop.isPending}
            onClick={() => controls.stop.mutate(session.session)}
          />
        </>
      )}
    </>
  );
}
