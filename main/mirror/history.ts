// What happened to each mirror, as a short thread the mirror page
// shows: the control ops (started, paused, stopped, ignores changed)
// noted by the handlers, and the transitions read off the daemon's
// snapshots and the git follower's verdicts (a disconnect, a halt, a
// conflict appearing, the git halves diverging and agreeing again).
// Keyed by the LOCAL worktree, not the session: an ignore change opens
// a fresh session on the same pair, and the thread must not restart
// with it. Bounded per worktree and persisted beside the engine's own
// data, so a restart keeps the recent past. Electron-free like the
// daemon: the store is injected.
import {
  MIRROR_HISTORY_LIMIT,
  type MirrorEvent,
  type MirrorEventKind,
  type MirrorGitStatus,
} from "@shared/ipc/modules/mirror";
import {
  localWorktreeIdOf,
  type MirrorSessionRaw,
} from "@host/mirror/registry";

// The two rows the link chatter around a pause or re-open repeats.
const LINK_KINDS: ReadonlySet<MirrorEventKind> = new Set([
  "connected",
  "disconnected",
]);

// What the recorder remembers of a session between two snapshots, the
// facts whose change is an event.
type Seen = {
  connected: boolean;
  // A "disconnected" row was noted and the link has not come back
  // since, so the next connection is news rather than the expected
  // first one.
  lostConnection: boolean;
  halted: boolean;
  lastError: string;
  conflicts: number;
  git: MirrorGitStatus["status"] | null;
};

export type MirrorHistoryStore = {
  load: () => Record<string, MirrorEvent[]>;
  save: (events: Record<string, MirrorEvent[]>) => void;
};

export function createMirrorHistory(deps: {
  store: MirrorHistoryStore;
  now?: () => number;
  onChange?: () => void;
}) {
  const now = deps.now ?? Date.now;
  let events: Record<string, MirrorEvent[]> | null = null;
  const seen = new Map<string, Seen>();
  // Writes are coalesced to one per turn: an observe pass can note
  // several events off one snapshot, and the save rewrites the file.
  let flushQueued = false;

  function queueFlush(): void {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      try {
        deps.store.save(all());
      } catch {
        // A failed save loses persistence, not the in-memory thread.
      }
      deps.onChange?.();
    });
  }

  function all(): Record<string, MirrorEvent[]> {
    if (events === null) {
      try {
        events = deps.store.load();
      } catch {
        events = {};
      }
    }
    return events;
  }

  function note(
    localWorktreeId: string,
    kind: MirrorEventKind,
    detail: string,
  ): void {
    if (localWorktreeId === "") return;
    const store = all();
    const thread = store[localWorktreeId] ?? [];
    // The link flips more than once around a pause or a re-open (the
    // session that replaced the old one is observed from scratch), and
    // two "disconnected" rows in a row say nothing the first did not.
    // Only the link kinds: a second conflict or a second git verdict
    // with the same words is its own event.
    const newest = thread[0];
    if (
      LINK_KINDS.has(kind) &&
      newest !== undefined &&
      newest.kind === kind &&
      newest.detail === detail
    ) {
      return;
    }
    // Newest first, so the page reads top-down and the cap drops the
    // oldest.
    thread.unshift({ at: now(), kind, detail });
    store[localWorktreeId] = thread.slice(0, MIRROR_HISTORY_LIMIT);
    queueFlush();
  }

  // The worktree is gone (the tombstone protocol says so), and with it
  // the only page the thread shows on. Without this the store keeps
  // one thread per worktree ever mirrored.
  // The thread's newest word on the link, for a session's baseline.
  function lastLinkEvent(localWorktreeId: string): MirrorEventKind | null {
    const thread = all()[localWorktreeId] ?? [];
    return thread.find((event) => LINK_KINDS.has(event.kind))?.kind ?? null;
  }

  function forget(localWorktreeId: string): void {
    const store = all();
    if (!(localWorktreeId in store)) return;
    delete store[localWorktreeId];
    queueFlush();
  }

  // Reads every session against what was last seen of it and notes
  // the transitions. A session seen for the first time sets its
  // baseline silently: its start was noted by the handler that made
  // it, and after a daemon restart the sessions come back as they
  // were.
  function observe(
    sessions: readonly MirrorSessionRaw[],
    gitStatusOf: (session: string) => MirrorGitStatus | undefined,
  ): void {
    const live = new Set<string>();
    for (const session of sessions) {
      live.add(session.session);
      const localWorktreeId = localWorktreeIdOf(session);
      const git = gitStatusOf(session.session);
      const previous = seen.get(session.session);
      const connected = session.local.connected && session.remote.connected;
      // A session's first connection is the expected course after
      // "started" and stays quiet, like the first git agreement below:
      // only a connection regained after a noted loss is news. A
      // paused session drops its link on purpose, so that is not a
      // loss either (the "paused" row says it). A session seen for the
      // first time (a daemon restart, a re-open) takes the thread's
      // word for whether a loss is outstanding, so the recovery after
      // a restart is still recorded.
      const lost =
        !connected &&
        (previous === undefined
          ? lastLinkEvent(localWorktreeId) === "disconnected"
          : previous.lostConnection || (previous.connected && !session.paused));
      const next: Seen = {
        connected,
        lostConnection: lost,
        halted: session.status.startsWith("halted-"),
        lastError: session.lastError ?? "",
        conflicts: session.conflicts.length + session.excludedConflicts,
        git: git?.status ?? null,
      };
      seen.set(session.session, next);
      if (previous === undefined) continue;
      if (connected && previous.lostConnection) {
        note(localWorktreeId, "connected", "");
      } else if (lost && !previous.lostConnection) {
        note(localWorktreeId, "disconnected", session.statusText);
      }
      if (next.halted && !previous.halted) {
        note(localWorktreeId, "halted", session.statusText);
      }
      if (next.lastError !== "" && next.lastError !== previous.lastError) {
        note(localWorktreeId, "error", next.lastError);
      } else if (next.lastError === "" && previous.lastError !== "") {
        note(localWorktreeId, "recovered", "");
      }
      if (next.conflicts > previous.conflicts) {
        const [first] = session.conflicts;
        note(
          localWorktreeId,
          "conflict",
          first === undefined
            ? `${next.conflicts} conflicts`
            : `${first.root}: changed on both sides`,
        );
      }
      if (next.git !== previous.git && git !== undefined) {
        switch (next.git) {
          case "diverged":
            note(localWorktreeId, "git-diverged", git.detail);
            break;
          case "blocked":
            note(localWorktreeId, "git-blocked", git.detail);
            break;
          case "error":
            note(localWorktreeId, "git-error", git.detail);
            break;
          case "synced":
            // Agreement after trouble is news. The first agreement
            // after a start is the expected course and stays quiet.
            if (
              previous.git === "diverged" ||
              previous.git === "blocked" ||
              previous.git === "error"
            ) {
              note(localWorktreeId, "git-synced", "");
            }
            break;
          default:
            break;
        }
      }
    }
    for (const session of seen.keys()) {
      if (!live.has(session)) seen.delete(session);
    }
  }

  return {
    note,
    forget,
    observe,
    eventsFor: (localWorktreeId: string): MirrorEvent[] =>
      all()[localWorktreeId] ?? [],
  };
}
