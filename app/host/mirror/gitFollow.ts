// The git follower: for every mirror session this device runs, keeps
// the git state of the local worktree and the peer's worktree the same
// (host/mirror/gitState.ts defines that state), so a commit, a stage,
// a checkout or a reset on either machine shows up on the other within
// a moment. The file-sync engine owns the files. This owns HEAD, the
// tip and the staged tree.
//
// Which way git follows is followPlan.ts's to decide, and the
// transfers are followTransfer.ts's.
//
// A side in the middle of a git operation (a rebase, a merge, a
// cherry-pick, a revert, a bisect) refuses to be read or written
// (gitState.ts GIT_OPERATION_IN_PROGRESS), and the session reads
// blocked until it finishes, naming the side. Mirroring the half-way
// state would carry a detached HEAD or a conflicted index to the other
// side, and the finished operation would then collide with it there.
//
// Git follows the files, never leads them. A change that moves the tip
// or the branch waits while the file-sync engine is mid-cycle: landing
// a checkout's HEAD and index before its files would show the other
// side a reverse diff, which a commit there would record as a revert.
// The engine's next idle snapshot sets the follow going again.
//
// Signals: the local git-directory watcher (a project ping), a local
// index watcher per session, the peer's git:projectChanged and
// mirror:gitChanged pushes, every daemon snapshot whose session set
// changed (or that finds a waiting session's files caught up), and a
// slow periodic sweep as the backstop. Reconciles are coalesced per
// session: one in flight, one queued.
import type { Project } from "@shigomori/contracts/schemas";
import { errorMessageOf, isEntityGoneError } from "@shigomori/contracts/errors";
import type { followDescription } from "@host/lib/sync/worktreeDescription";
import {
  isHaltedStatus,
  MIRROR_LABEL_REPLACES,
  type MirrorGitStatus,
} from "@shigomori/contracts/modules/mirror";
import type { PeerMirrorApi, PeerSyncApi } from "@host/ipc/peerSync";
import * as Engine from "@host/lib/engine";
import { findProject } from "@host/lib/projects";
import {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  onMirrorBranch,
} from "./registry";
import {
  CHANGED_LOCALLY,
  core,
  type FollowableSession,
  describeDivergence,
  MIRROR_NAMES,
  OFF_MIRROR_BRANCH,
  operationDetail,
  SAME_NAMES,
  sameHead,
  sameState,
} from "./followPlan";
import { chooseDirection, pull, push } from "./followTransfer";
import {
  type GitState,
  type GitStateCore,
  operationInRefusal,
  readGitState,
  watchIndexFile,
} from "./gitState";
import { log } from "@shared/log";

// Where the agreed states live between runs: one entry per session id.
export type AgreedStore = {
  load(): Record<string, GitStateCore>;
  save(entries: Record<string, GitStateCore>): void;
};

type FollowRecord = {
  session: FollowableSession;
  status: MirrorGitStatus;
  agreed: GitStateCore | null;
  // The reconcile loop in flight (it runs the queued follow-up too
  // before settling), or null when idle.
  running: Promise<void> | null;
  pending: boolean;
  // A follow that moves the tip or the branch was held back for the
  // files to settle. The next idle snapshot re-triggers it.
  waitingForFiles: boolean;
  stopIndexWatch: (() => void) | null;
};

// The backstop only: every real change arrives as a signal, so the
// sweep is slow, and each tick costs a local read plus one peer round
// trip per session.
const DEFAULT_SWEEP_MS = 60_000;

// How often a session whose copy reads as gone is reported to
// onCopyGone: every signal fails the same way until the owner acts.
const COPY_GONE_EVERY_MS = 60_000;

// How long reconcileNow waits on a reconcile before answering with the
// status as it stands. A stalled peer can hold a round for as long as
// its transport's timeout, and the caller is a user waiting on a stop.
const RECONCILE_NOW_LIMIT_MS = 10_000;

export function createGitFollower(deps: {
  sessions: () => readonly FollowableSession[];
  // The engine the local projects are read from and the bundles made
  // and unpacked on, once it is up.
  engine: () => Promise<Engine.Handle>;
  peerSyncApiFor: (deviceId: string) => PeerSyncApi;
  peerMirrorApiFor: (deviceId: string) => PeerMirrorApi;
  // Persists the agreed state per session. Absent means memory only
  // (the checks).
  agreedStore?: AgreedStore;
  // Fires when any session's git status changes.
  onChange?: () => void;
  sweepMs?: number;
  log?: (message: string) => void;
  // The peer answered that the session's copy is not a worktree it
  // lists (deleted, moved, or re-created where its id points elsewhere,
  // none of which announced itself here). A peer that is merely away
  // answers nothing and is no such report. At most once a minute per
  // session.
  onCopyGone?: (session: FollowableSession) => void;
  // Carries the worktree's title and description between the two
  // sides (host/lib/sync/worktreeDescription.ts) on every reconcile
  // that reaches the peer, whatever the git state decides, answering
  // which side it wrote. A write here is the app's own, which the
  // state watcher skips, so it is announced like a pull's apply
  // (onLocalApplied). Absent in the checks that don't exercise it.
  followDescription?: (
    ...args: Parameters<typeof followDescription>
  ) => Promise<"here" | "there" | null>;
  // A pull landed here: refs, HEAD and the index moved in the local
  // project by the app's own git, which the git-directory watcher
  // skips as the app's own writes, so nothing else would tell this
  // device's pages (and its viewers) that the worktree moved.
  onLocalApplied?: (localProjectId: string) => void;
}) {
  const records = new Map<string, FollowRecord>();
  const copyGoneAt = new Map<string, number>();
  // Sessions whose title carry has failed, so a peer that can't take it
  // (an older build) is reported once, not on every sweep.
  const descriptionFailed = new Set<string>();
  const warn = deps.log ?? ((message: string) => log.warn(message));
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  // The agreed states by session id, loaded on the first start (the
  // follower is built at module load, before the data dir exists)
  // and written back only when an entry actually changes.
  let stored: Record<string, GitStateCore> = {};
  let loaded = false;

  function loadStored(): void {
    if (loaded) return;
    loaded = true;
    try {
      stored = deps.agreedStore?.load() ?? {};
    } catch (error) {
      warn(
        `[mirror] git follow: agreed store unreadable: ${errorMessageOf(error)}`,
      );
    }
  }

  function setStatus(record: FollowRecord, status: MirrorGitStatus): void {
    if (
      record.status.status === status.status &&
      record.status.detail === status.detail
    ) {
      return;
    }
    record.status = status;
    deps.onChange?.();
  }

  function persist(): void {
    try {
      deps.agreedStore?.save(stored);
    } catch (error) {
      warn(
        `[mirror] git follow: agreed store unwritable: ${errorMessageOf(error)}`,
      );
    }
  }

  function setAgreed(record: FollowRecord, agreed: GitStateCore): void {
    if (record.agreed !== null && sameState(record.agreed, agreed)) return;
    record.agreed = agreed;
    stored[record.session.session] = agreed;
    persist();
  }

  // Starts a reconcile, or queues one behind the reconcile in flight.
  // Resolves once the loop settles, the queued follow-up included.
  function trigger(record: FollowRecord): Promise<void> {
    if (record.running !== null) {
      record.pending = true;
      return record.running;
    }
    const loop = (async () => {
      try {
        do {
          record.pending = false;
          // oxlint-disable-next-line no-await-in-loop -- reconciles are serial per session by design
          await reconcile(record);
        } while (
          record.pending &&
          records.get(record.session.session) === record
        );
      } finally {
        record.running = null;
      }
    })();
    record.running = loop;
    return loop;
  }

  function copyGone(session: FollowableSession): void {
    if (deps.onCopyGone === undefined) return;
    const now = Date.now();
    const last = copyGoneAt.get(session.session);
    if (last !== undefined && now - last < COPY_GONE_EVERY_MS) return;
    copyGoneAt.set(session.session, now);
    try {
      deps.onCopyGone(session);
    } catch (error) {
      warn(
        `[mirror] git follow ${session.session}: ending a gone copy failed: ${errorMessageOf(error)}`,
      );
    }
  }

  // The engine's status for the session as it stands, fresher than the
  // record's copy (only as new as the last session-set change).
  function engineStatus(record: FollowRecord): FollowableSession["status"] {
    const id = record.session.session;
    return (
      deps.sessions().find((s) => s.session === id)?.status ??
      record.session.status
    );
  }

  // Whether the files are idle enough for a follow that moves the tip
  // or the branch. If not, the record waits for the snapshot that says
  // they are (syncSessions). The engine's status is read fresh, since
  // the record's copy is only as new as the last session-set change.
  // A halted session will not catch up by itself, so it reads blocked
  // rather than following forever. A paused one never gets here.
  function filesSettled(record: FollowRecord): boolean {
    const status = engineStatus(record);
    if (status === "watching") return true;
    record.waitingForFiles = true;
    setStatus(
      record,
      isHaltedStatus(status)
        ? {
            status: "blocked",
            detail: "file sync has halted. Git follows again once it runs",
          }
        : { status: "following", detail: "waiting for files to catch up" },
    );
    return false;
  }

  function triggerWhere(
    matches: (session: FollowableSession) => boolean,
  ): void {
    for (const record of records.values()) {
      if (matches(record.session)) void trigger(record);
    }
  }

  async function reconcile(record: FollowRecord): Promise<void> {
    const { session } = record;
    if (session.paused) {
      record.waitingForFiles = false;
      setStatus(record, { status: "off", detail: "paused" });
      return;
    }
    // Still waiting on the files: the reads would only end at the same
    // wait (filesSettled restates it, a halt included), and the idle
    // snapshot triggers this again (syncSessions).
    if (record.waitingForFiles && !filesSettled(record)) return;
    record.waitingForFiles = false;
    const localProjectId = session.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "";
    const localWorktreeId = session.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "";
    let project: Project;
    let engine: Engine.Handle;
    try {
      engine = await deps.engine();
      project = await Engine.runWith(engine)(findProject(localProjectId));
    } catch (error) {
      setStatus(record, { status: "error", detail: errorMessageOf(error) });
      return;
    }
    const localWorktree = { id: localWorktreeId, path: session.localRoot };
    const peerSync = deps.peerSyncApiFor(session.deviceId);
    const peerMirror = deps.peerMirrorApiFor(session.deviceId);
    const names = onMirrorBranch(session) ? MIRROR_NAMES : SAME_NAMES;
    try {
      // Independent reads, so the local git work hides under the peer
      // round trip. The apply's compare-and-set covers either side
      // moving in between. Settled apart, since which side failed is
      // what decides the report.
      const [localRead, peerRead] = await Promise.allSettled([
        readGitState(project.path, localWorktree.path, localWorktree.id),
        peerMirror.gitState({
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        }),
      ]);
      // Only once the peer has answered, so an unreachable one is not
      // a failure logged on every sweep.
      if (peerRead.status === "fulfilled") {
        deps
          .followDescription?.(
            session.deviceId,
            { projectId: localProjectId, worktreeId: localWorktreeId },
            { projectId: session.projectId, worktreeId: session.worktreeId },
          )
          .then((wrote) => {
            descriptionFailed.delete(session.session);
            if (wrote === "here") deps.onLocalApplied?.(localProjectId);
          })
          .catch((error: unknown) => {
            if (descriptionFailed.has(session.session)) return;
            descriptionFailed.add(session.session);
            warn(
              `[mirror] following the title and description failed: ${errorMessageOf(error)}`,
            );
          });
      }
      const peerOperation =
        peerRead.status === "rejected"
          ? operationInRefusal(errorMessageOf(peerRead.reason))
          : null;
      if (
        peerRead.status === "rejected" &&
        isEntityGoneError(peerRead.reason)
      ) {
        copyGone(session);
      }
      if (localRead.status === "rejected") {
        const operation = operationInRefusal(errorMessageOf(localRead.reason));
        if (operation === null) throw localRead.reason;
        setStatus(record, {
          status: "blocked",
          detail: operationDetail(operation, "here"),
        });
        return;
      }
      if (peerRead.status === "rejected") {
        if (peerOperation === null) throw peerRead.reason;
        setStatus(record, {
          status: "blocked",
          detail: operationDetail(peerOperation, "there"),
        });
        return;
      }
      const local = localRead.value;
      const peerAsIs = peerRead.value;
      // Each side's head in the other's names: the peer's is what
      // agreement, divergence and the apply are judged on, this side's
      // is what a push carries. A copy that left the mirror/ rule has
      // no name on the other side, and is reported, not followed.
      const peerHead = names.toLocal(peerAsIs.head);
      const headThere = names.toPeer(local.head);
      if (peerHead === null || headThere === null) {
        setStatus(record, { status: "blocked", detail: OFF_MIRROR_BRANCH });
        return;
      }
      const peer: GitState = { ...peerAsIs, head: peerHead };
      if (sameState(local, peer)) {
        setAgreed(record, core(peer));
        setStatus(record, { status: "synced", detail: "" });
        return;
      }

      const direction = await chooseDirection(
        project.path,
        record.agreed,
        local,
        peer,
      );
      if (direction === "diverged") {
        setStatus(record, {
          status: "diverged",
          detail: describeDivergence(local, peer),
        });
        return;
      }
      // Moving the tip or the branch rewrites what `git status` compares
      // the files against, so it waits for the files to land first. An
      // index-only change does not: the engine already carried whatever
      // was staged.
      const movesTip =
        local.tip !== peer.tip || !sameHead(local.head, peer.head);
      if (movesTip && !filesSettled(record)) return;
      setStatus(record, {
        status: "following",
        detail:
          direction === "pull"
            ? "from the other device"
            : "to the other device",
      });

      const round = {
        project,
        localWorktree,
        session,
        peerSync,
        peerMirror,
        local,
        peer,
        engine,
      };
      const outcome =
        direction === "pull"
          ? await pull(round, peerAsIs.head, record.agreed?.tip ?? null)
          : await push(round, headThere);
      if (outcome.applied) {
        setAgreed(record, direction === "pull" ? core(peer) : core(local));
        setStatus(record, { status: "synced", detail: "" });
        if (direction === "pull") deps.onLocalApplied?.(localProjectId);
        return;
      }
      if (outcome.reason === CHANGED_LOCALLY) {
        // The side being written moved between our read and the
        // apply. Look again right away.
        record.pending = true;
        return;
      }
      setStatus(record, { status: "blocked", detail: outcome.reason });
    } catch (error) {
      warn(`[mirror] git follow ${session.session}: ${errorMessageOf(error)}`);
      setStatus(record, { status: "error", detail: errorMessageOf(error) });
    }
  }

  // Bring the followed set in line with the daemon's sessions: a new
  // session gets a record (seeded from the stored agreement) and an
  // index watcher, a gone one is dropped. Its stored agreement stays:
  // the daemon reports no sessions while it restarts, and the same
  // sessions come back a moment later. Only forget() below, on an
  // explicit terminate, drops the agreement. True when a session
  // came, went or flipped its pause. A session that replaced another (a
  // re-open, MIRROR_LABEL_REPLACES) and has no agreement of its own
  // starts from the replaced one's. A record waiting for its files is
  // triggered here the moment the engine reports them idle.
  function syncSessions(): boolean {
    loadStored();
    const current = new Map(deps.sessions().map((s) => [s.session, s]));
    let changed = false;
    for (const [id, record] of records) {
      if (!current.has(id)) {
        record.stopIndexWatch?.();
        records.delete(id);
        copyGoneAt.delete(id);
        changed = true;
      }
    }
    for (const [id, session] of current) {
      const existing = records.get(id);
      if (existing !== undefined) {
        if (existing.session.paused !== session.paused) changed = true;
        existing.session = session;
        if (existing.waitingForFiles && session.status === "watching") {
          existing.waitingForFiles = false;
          void trigger(existing);
        }
        continue;
      }
      changed = true;
      const record: FollowRecord = {
        session,
        status: { status: "off", detail: "" },
        agreed: stored[id] ?? inheritAgreement(id, session),
        running: null,
        pending: false,
        waitingForFiles: false,
        stopIndexWatch: null,
      };
      records.set(id, record);
      void watchIndexFile(session.localRoot, () => void trigger(record)).then(
        (stop) => {
          if (records.get(id) === record) record.stopIndexWatch = stop;
          else stop();
        },
        () => {},
      );
    }
    if (changed) deps.onChange?.();
    return changed;
  }

  function inheritAgreement(
    id: string,
    session: FollowableSession,
  ): GitStateCore | null {
    const replaced = session.labels[MIRROR_LABEL_REPLACES];
    const inherited = replaced === undefined ? undefined : stored[replaced];
    if (inherited === undefined) return null;
    stored[id] = inherited;
    persist();
    return inherited;
  }

  function reconcileAll(): void {
    syncSessions();
    for (const record of records.values()) void trigger(record);
  }

  return {
    start(): void {
      reconcileAll();
      if (sweepTimer === null) {
        sweepTimer = setInterval(
          reconcileAll,
          deps.sweepMs ?? DEFAULT_SWEEP_MS,
        );
        sweepTimer.unref?.();
      }
    },
    stop(): void {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const record of records.values()) record.stopIndexWatch?.();
      records.clear();
    },
    // The daemon reported a snapshot: only a session coming, going or
    // flipping its pause is worth a re-look.
    sessionsChanged(): void {
      if (syncSessions()) {
        for (const record of records.values()) void trigger(record);
      }
    },
    // The session was terminated on purpose: its agreement goes too.
    forget(session: string): void {
      loadStored();
      if (session in stored) {
        delete stored[session];
        persist();
      }
    },
    // The session was re-opened under a new id on the same pair (an
    // ignore change): the agreement follows it, on disk and on the
    // live record if the daemon's snapshot already made one. An
    // agreement the new id already holds (inherited through its
    // replaces label, or reached since) is newer and stays.
    rename(from: string, to: string): void {
      loadStored();
      const agreed = stored[from];
      if (agreed === undefined) return;
      delete stored[from];
      stored[to] ??= agreed;
      persist();
      const record = records.get(to);
      if (record !== undefined && record.agreed === null)
        record.agreed = stored[to];
    },
    // A reconcile of one session right away, for a caller about to act
    // on its verdict (a stop's safety check): queued behind one in
    // flight, and answered once both have run. Bounded, so a stalled
    // peer answers with the status as it stands. Undefined when the
    // session is not followed.
    async reconcileNow(session: string): Promise<MirrorGitStatus | undefined> {
      syncSessions();
      const record = records.get(session);
      if (record === undefined) return undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        trigger(record),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RECONCILE_NOW_LIMIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      return records.get(session)?.status;
    },
    onLocalProjectChanged(projectId: string): void {
      syncSessions();
      triggerWhere((s) => s.labels[MIRROR_LABEL_LOCAL_PROJECT] === projectId);
    },
    onPeerProjectChanged(deviceId: string, projectId: string): void {
      triggerWhere((s) => s.deviceId === deviceId && s.projectId === projectId);
    },
    onPeerWorktreeChanged(
      deviceId: string,
      projectId: string,
      worktreeId: string,
    ): void {
      triggerWhere(
        (s) =>
          s.deviceId === deviceId &&
          s.projectId === projectId &&
          s.worktreeId === worktreeId,
      );
    },
    statusOf(session: string): MirrorGitStatus | undefined {
      return records.get(session)?.status;
    },
  };
}
