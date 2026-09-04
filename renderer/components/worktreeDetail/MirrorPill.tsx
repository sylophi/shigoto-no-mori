// The worktree header's mirror line: what this worktree's live mirror
// is doing, if it has one. Two shapes, both quiet when there is
// nothing to say:
//   - this worktree is the LOCAL copy of a peer's worktree (a session
//     this device runs): status, conflicts and problems, plus pause /
//     resume / stop when viewed on the machine that runs it.
//   - this worktree is being mirrored BY peers (streams this device
//     serves): one chip naming them.
// Built on the shared chip (ui/chip-button.tsx) and the status tones
// (ui/status-dot.tsx): emerald for a settled live mirror, sky while
// cycles run, amber for conflicts and reconnects, rose for a halt or
// an error, slate for paused and for the controls.
import { Loader2, Pause, Play, RefreshCw, Square } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import type { MirrorSession, MirrorStatus } from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { Chip, ChipButton } from "@/components/ui/chip-button";
import { type StatusTone, TONE_TEXT } from "@/components/ui/status-dot";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  useMirrorControls,
  useWorktreeMirror,
} from "@/hooks/remote/useMirrors";
import { useRemoteDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

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
// stored error, then the git half's verdict, then conflicts, then
// problems, then the ordinary lifecycle.
function describe(session: MirrorSession): {
  tone: StatusTone;
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
      tone: "slate",
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
  // blocked branch is the thing to act on. Files keep mirroring
  // meanwhile. Only the git state is frozen.
  if (session.git?.status === "diverged") {
    return {
      tone: "amber",
      label: "Git diverged",
      detail: `${session.git.detail}. Files keep syncing. Git state is frozen until you put one side back.`,
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

function ChipIcon({
  icon: Icon,
  spinning,
}: {
  icon: IconType;
  spinning: boolean;
}) {
  return (
    <Icon aria-hidden className={cn("size-3.5", spinning && "animate-spin")} />
  );
}

// A read-only status chip in one of the status tones.
function StatusChip({
  tone,
  icon,
  label,
  title,
  spinning = false,
}: {
  tone: StatusTone;
  icon: IconType;
  label: string;
  title: string;
  spinning?: boolean;
}) {
  return (
    <Chip className={cn("tabular shrink-0", TONE_TEXT[tone])} title={title}>
      <ChipIcon icon={icon} spinning={spinning} />
      {label}
    </Chip>
  );
}

// A control chip. The mutation's in-flight state swaps its icon for
// a spinner and disables it.
function ActionChip({
  icon,
  label,
  title,
  pending,
  onClick,
}: {
  icon: IconType;
  label: string;
  title: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <ChipButton
      className="shrink-0"
      title={title}
      onClick={onClick}
      disabled={pending}
    >
      <ChipIcon icon={pending ? Loader2 : icon} spinning={pending} />
      {label}
    </ChipButton>
  );
}

// The other party by name: a peer's label, or "this device" when the
// worktree being viewed is served TO the machine showing it (a remote
// worktree page on the device that mirrors it).
function PeerName({ deviceId }: { deviceId: string }) {
  const label = useRemoteDeviceLabel(deviceId);
  if (deviceId === localDeviceId) return <>this device</>;
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
      {serving.length > 0 && (
        <>
          <StatusChip
            tone="emerald"
            icon={RefreshCw}
            label="Mirrored elsewhere"
            title="A peer keeps a live copy of this worktree"
          />
          <span className="text-muted-foreground">
            to{" "}
            {serving.map((stream, index) => (
              <span key={stream.channelId}>
                {index > 0 && ", "}
                <PeerName deviceId={stream.peerDeviceId} />
              </span>
            ))}
          </span>
        </>
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
      <StatusChip
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
            <ActionChip
              icon={Play}
              label="Resume"
              title="Resume mirroring"
              pending={controls.resume.isPending}
              onClick={() => controls.resume.mutate(session.session)}
            />
          ) : (
            <ActionChip
              icon={Pause}
              label="Pause"
              title="Pause mirroring (files stay where they are)"
              pending={controls.pause.isPending}
              onClick={() => controls.pause.mutate(session.session)}
            />
          )}
          <ActionChip
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
