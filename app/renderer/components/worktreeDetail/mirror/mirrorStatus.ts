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

type MirrorLook = {
  tone: StatusTone;
  label: string;
  detail: string;
  spinning: boolean;
  // Set only by the conflict branch, which is the one chip with a
  // list behind it (MirrorConflicts.tsx).
  showConflicts?: boolean;
};

const look = (
  tone: StatusTone,
  label: string,
  detail = "",
  spinning = false,
): MirrorLook => ({ tone, label, detail, spinning });

export function describeMirror(session: MirrorSession): MirrorLook {
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
  if (session.paused) return look("slate", "Paused");
  if (isHaltedStatus(session.status)) {
    return look("rose", "Halted", session.statusText);
  }
  if (session.lastError) return look("rose", "Error", session.lastError);
  // The git half's verdict outranks file-level news: a diverged or
  // blocked branch is the thing to act on. Files keep mirroring
  // meanwhile. Only the git state is frozen.
  if (session.git?.status === "diverged") {
    return look(
      "amber",
      "Git diverged",
      `${session.git.detail}. Files keep syncing. Git waits until one side is put back.`,
    );
  }
  if (session.git?.status === "blocked" || session.git?.status === "error") {
    return look(
      "rose",
      session.git.status === "blocked" ? "Git blocked" : "Git error",
      session.git.detail,
    );
  }
  if (conflicts > 0) {
    return {
      ...look("amber", pluralize(conflicts, "conflict")),
      showConflicts: true,
    };
  }
  if (problems > 0) {
    return look(
      "rose",
      pluralize(problems, "problem"),
      [...session.local.problems, ...session.remote.problems]
        .map((p) => `${p.path}: ${p.error}`)
        .slice(0, 5)
        .join("\n"),
    );
  }
  if (
    session.status === "connecting-local" ||
    session.status === "connecting-remote" ||
    session.status === "disconnected"
  ) {
    return look("amber", "Reconnecting", lifecycle, true);
  }
  if (
    MOVING.has(session.status) ||
    (CHECKING.has(session.status) && firstPass) ||
    session.git?.status === "following"
  ) {
    return look(
      "sky",
      "Syncing",
      session.git?.status === "following"
        ? `git ${session.git.detail}`
        : lifecycle,
      true,
    );
  }
  return look("emerald", "Live", lifecycle);
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
