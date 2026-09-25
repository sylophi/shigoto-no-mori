// One line of truth about a mirror session, shared by the header
// pill, the dialogs and the sidebar row so every surface ranks the
// same news the same way: a halt or a stored error first, then the
// git half's verdict, then conflicts, then problems, then the ordinary
// lifecycle. The label is one or two words. The surfaces add "mirror"
// or the peer's name themselves.
import {
  isHaltedStatus,
  type MirrorSession,
  type MirrorStatus,
} from "@shared/ipc/modules/mirror";
import type { StatusTone } from "@/components/ui/status-dot";
import { pluralize } from "@/lib/pluralize";

// The states in which files cross or are written. The engine passes
// through them on every cycle, but only stays long enough to be seen
// when there is something to move.
const MOVING: ReadonlySet<MirrorStatus> = new Set([
  "staging-local",
  "staging-remote",
  "transitioning",
]);

// The engine's bookkeeping around a cycle. Any filesystem event on
// either side starts one, ignored paths included (Mutagen's watcher
// only filters its own temp files), so a build cache or a log being
// written sends a live mirror through these states and back without
// a file moving. After the first pass they read as Live. The first
// pass stays Syncing, since nothing has been brought in step yet.
const CHECKING: ReadonlySet<MirrorStatus> = new Set([
  "scanning",
  "waiting-for-rescan",
  "reconciling",
  "saving",
]);

// The engine's own description of a lifecycle state is written in its
// own terms ("Connecting to beta"), which says nothing to someone
// looking at two worktrees. The status code beside it is stable and
// ours to phrase, so the states a working mirror passes through are
// read from that instead. statusText stays for halts and errors,
// where the engine's wording is the news.
const STATUS_DETAIL: Partial<Record<MirrorStatus, string>> = {
  disconnected: "waiting for the other device",
  "connecting-local": "opening this copy",
  "connecting-remote": "connecting to the other device",
  watching: "watching for changes",
  scanning: "looking for changes",
  "waiting-for-rescan": "waiting to look again",
  reconciling: "working out what changed",
  "staging-local": "receiving files",
  "staging-remote": "sending files",
  transitioning: "applying changes",
  saving: "saving state",
};

export function describeMirror(session: MirrorSession): {
  tone: StatusTone;
  label: string;
  detail: string;
  spinning: boolean;
  // Set only by the conflict branch, which is the one chip with a
  // list behind it (MirrorConflicts.tsx).
  showConflicts?: boolean;
} {
  const problems =
    session.local.problems.length +
    session.remote.problems.length +
    session.local.excludedProblems +
    session.remote.excludedProblems;
  const conflicts = session.conflicts.length + session.excludedConflicts;
  // A check after the first pass reads as Live and keeps the watching
  // detail, so the line beside the label holds still through it.
  const firstPass = session.successfulCycles === 0;
  const quietCheck = CHECKING.has(session.status) && !firstPass;
  const lifecycle =
    STATUS_DETAIL[quietCheck ? "watching" : session.status] ?? "";
  if (session.paused) {
    return { tone: "slate", label: "Paused", detail: "", spinning: false };
  }
  if (isHaltedStatus(session.status)) {
    return {
      tone: "rose",
      label: "Halted",
      detail: session.statusText,
      spinning: false,
    };
  }
  if (session.lastError) {
    return {
      tone: "rose",
      label: "Error",
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
      detail: `${session.git.detail}. Files keep syncing. Git waits until one side is put back.`,
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
      label: "Git error",
      detail: session.git.detail,
      spinning: false,
    };
  }
  if (conflicts > 0) {
    return {
      tone: "amber",
      label: pluralize(conflicts, "conflict"),
      detail: "",
      spinning: false,
      showConflicts: true,
    };
  }
  if (problems > 0) {
    return {
      tone: "rose",
      label: pluralize(problems, "problem"),
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
      label: "Reconnecting",
      detail: lifecycle,
      spinning: true,
    };
  }
  if (
    MOVING.has(session.status) ||
    (CHECKING.has(session.status) && firstPass) ||
    session.git?.status === "following"
  ) {
    return {
      tone: "sky",
      label: "Syncing",
      detail:
        session.git?.status === "following"
          ? `git ${session.git.detail}`
          : lifecycle,
      spinning: true,
    };
  }
  return {
    tone: "emerald",
    label: "Live",
    detail: lifecycle,
    spinning: false,
  };
}

// The git half in two or three words, for the manage dialog's stat.
export function gitVerdict(git: MirrorSession["git"]): {
  label: string;
  tone: StatusTone;
} {
  switch (git?.status) {
    case "synced":
      return { label: "In step", tone: "emerald" };
    case "following":
      return { label: "Following", tone: "sky" };
    case "diverged":
      return { label: "Diverged", tone: "amber" };
    case "blocked":
      return { label: "Blocked", tone: "rose" };
    case "error":
      return { label: "Error", tone: "rose" };
    case "off":
      return { label: "Off", tone: "slate" };
    case undefined:
      return { label: "Starting", tone: "slate" };
  }
}
