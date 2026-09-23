// The git follower: for every mirror session this device runs, keeps
// the git state of the local worktree and the peer's worktree the same
// (host/mirror/gitState.ts defines that state), so a commit, a stage,
// a checkout or a reset on either machine shows up on the other within
// a moment. The file-sync engine owns the files. This owns HEAD, the
// tip and the staged tree.
//
// One rule decides direction, and it is the rule that makes the
// follower safe: a side is followed only if the OTHER side's tip has
// not moved since the two last agreed. The follower remembers the
// state both sides last shared, and persists it through the injected
// store so the rule survives an app restart. If only the peer's tip
// (or branch) moved, the peer's state is carried here (commits through
// the existing bundle pull, then a compare-and-set apply), its index
// included. If only this side's moved, it is carried to the peer (a
// bundle push, then the peer's apply). If both moved, the session is
// reported diverged and neither side's git state is touched until the
// user resolves it, which is as simple as putting one side back on the
// tip they last agreed on (dropping that side's commit). The same
// holds for a branch collision the apply refuses. Staging alone never
// makes a divergence unless both sides staged something different
// with neither committing. Because "moved since we agreed" rather
// than ancestry is the test, an amend or a rebase on one side follows
// cleanly as long as the other side stayed put.
//
// Before the two sides have ever agreed (a session with no stored
// agreement), ancestry decides: the peer is the reference when the
// tips are equal or the local tip is an ancestor of the peer's, which
// is exactly the state mirror:start leaves behind (a pull, then a
// mirror). A session started the other way (mirror:startTo, the copy
// on the peer) turns the tie around: on equal tips the original here
// is the reference. This side is the reference when the peer's tip is an
// ancestor of the local one. Anything else is diverged from the start.
//
// Signals: the local git-directory watcher (a project ping), a local
// index watcher per session, the peer's git:projectChanged and
// mirror:gitChanged pushes, every daemon snapshot whose session set
// changed, and a slow periodic sweep as the backstop. Reconciles are
// coalesced per session: one in flight, one queued. Each session has a
// fiber of its own draining a sliding queue of capacity one (a signal
// while one is queued changes nothing), and the sweep is a fiber on a
// spaced schedule. All of them live in the follower's scope, which
// stop() closes.
import { Effect, Exit, Fiber, Queue, Schedule, Schema, Scope } from "effect";
import type { Project } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import {
  GitStateSchema,
  type MirrorGitStatus,
  MirrorApplyGitStateResultSchema,
  mirrorCopyIsRemote,
} from "@shared/ipc/modules/mirror";
import { SyncHasCommitsResultSchema } from "@shared/ipc/modules/sync";
import { hasCommit, isAncestor, localBranchTips } from "@host/lib/git/refs";
import { findProjectOrThrow } from "@host/lib/projects";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { pushBundleToPeer } from "@host/lib/sync/pushBundle";
import type { PeerMirrorApi, PeerSyncApi } from "@host/ipc/peerSync";
import {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
} from "@host/ipc/modules/mirror";
import {
  applyGitState,
  type GitHead,
  type GitState,
  type GitStateCore,
  indexRefFor,
  readGitState,
  watchIndexFile,
} from "./gitState";

// The slice of a daemon session the follower reads.
export type FollowableSession = {
  session: string;
  paused: boolean;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  localRoot: string;
  labels: Record<string, string>;
};

// Where the agreed states live between runs: one entry per session id.
export type AgreedStore = {
  load(): Record<string, GitStateCore>;
  save(entries: Record<string, GitStateCore>): void;
};

// The label keys mirror:start writes.
const LABEL_LOCAL_PROJECT = MIRROR_LABEL_LOCAL_PROJECT;
const LABEL_LOCAL_WORKTREE = MIRROR_LABEL_LOCAL_WORKTREE;

type FollowRecord = {
  session: FollowableSession;
  status: MirrorGitStatus;
  agreed: GitStateCore | null;
  // The session's reconcile queue, set by its drain fiber as it
  // starts, and whether a signal came before then (the fiber queues it
  // once it has the queue).
  queue: Queue.Queue<void> | null;
  early: boolean;
  drain: Fiber.Fiber<void> | null;
  stopIndexWatch: (() => void) | null;
};

// The backstop only: every real change arrives as a signal, so the
// sweep is slow, and each tick costs a local read plus one peer round
// trip per session.
const DEFAULT_SWEEP_MS = 60_000;

function sameHead(a: GitHead, b: GitHead): boolean {
  return a.kind === "branch" && b.kind === "branch"
    ? a.branch === b.branch
    : a.kind === b.kind;
}

function sameState(a: GitStateCore, b: GitStateCore): boolean {
  return (
    a.tip === b.tip && a.indexTree === b.indexTree && sameHead(a.head, b.head)
  );
}

function core(state: GitState): GitStateCore {
  return { head: state.head, tip: state.tip, indexTree: state.indexTree };
}

type Outcome = { applied: true } | { applied: false; reason: string };

// Asks for a reconcile. One in flight, one queued: the queue slides,
// so a signal while one is already waiting is absorbed by it.
function trigger(record: FollowRecord): void {
  if (record.queue === null) record.early = true;
  else Queue.offerUnsafe(record.queue, undefined);
}

export function createGitFollower(deps: {
  sessions: () => FollowableSession[];
  peerSyncApiFor: (deviceId: string) => PeerSyncApi;
  peerMirrorApiFor: (deviceId: string) => PeerMirrorApi;
  // Persists the agreed state per session. Absent means memory only
  // (the checks).
  agreedStore?: AgreedStore;
  // Fires when any session's git status changes.
  onChange?: () => void;
  sweepMs?: number;
  log?: (message: string) => void;
}) {
  const records = new Map<string, FollowRecord>();
  const log = deps.log ?? ((message: string) => console.warn(message));
  // Where the drain fibers and the sweep run. Opened on first use and
  // closed by stop(), which interrupts every one of them.
  let scope: Scope.Closeable | null = null;
  let sweeper: Fiber.Fiber<void> | null = null;
  const followScope = (): Scope.Closeable => (scope ??= Scope.makeUnsafe());
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
      log(
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
      log(
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

  // The session's drain: one reconcile per queued signal, serial by
  // construction. A reconcile never fails (it reports
  // through the status), and a throw out of it (an owner callback) is
  // contained and logged, since a defect in a forked fiber is reported
  // nowhere and would end the session's follow. Interrupting the fiber
  // (the session went, or the follower stopped) stops waiting on a
  // reconcile in flight, which finishes on its own.
  function startDrain(record: FollowRecord): void {
    const reconcileOnce = Effect.tryPromise({
      try: () => reconcile(record),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          log(
            `[mirror] git follow ${record.session.session}: ${errorMessageOf(error)}`,
          ),
        ),
      ),
    );
    record.drain = Fiber.runIn(
      Effect.runFork(
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<void>(1);
          record.queue = queue;
          if (record.early) yield* Queue.offer(queue, undefined);
          while (true) {
            yield* Queue.take(queue);
            yield* reconcileOnce;
          }
        }),
      ),
      followScope(),
    );
  }

  function triggerWhere(
    matches: (session: FollowableSession) => boolean,
  ): void {
    for (const record of records.values()) {
      if (matches(record.session)) trigger(record);
    }
  }

  async function reconcile(record: FollowRecord): Promise<void> {
    const { session } = record;
    if (session.paused) {
      setStatus(record, { status: "off", detail: "paused" });
      return;
    }
    const localProjectId = session.labels[LABEL_LOCAL_PROJECT] ?? "";
    const localWorktreeId = session.labels[LABEL_LOCAL_WORKTREE] ?? "";
    let project: Project;
    try {
      project = findProjectOrThrow(localProjectId);
    } catch (error) {
      setStatus(record, { status: "error", detail: errorMessageOf(error) });
      return;
    }
    const localWorktree = { id: localWorktreeId, path: session.localRoot };
    const peerSync = deps.peerSyncApiFor(session.deviceId);
    const peerMirror = deps.peerMirrorApiFor(session.deviceId);
    try {
      // Independent reads, so the local git work hides under the peer
      // round trip. The apply's compare-and-set covers either side
      // moving in between.
      const [local, peerRaw] = await Promise.all([
        readGitState(project.path, localWorktree.path, localWorktree.id),
        peerMirror.gitState({
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        }),
      ]);
      const peer = Schema.decodeUnknownSync(GitStateSchema)(peerRaw);
      if (sameState(local, peer)) {
        setAgreed(record, core(peer));
        setStatus(record, { status: "synced", detail: "" });
        return;
      }

      const direction = await decide(
        project,
        record,
        local,
        peer,
        mirrorCopyIsRemote(session),
      );
      if (direction === "diverged") {
        setStatus(record, {
          status: "diverged",
          detail: describeDivergence(local, peer),
        });
        return;
      }
      setStatus(record, {
        status: "following",
        detail:
          direction === "pull"
            ? "from the other device"
            : "to the other device",
      });

      const outcome =
        direction === "pull"
          ? await pull(project, localWorktree, session, peerSync, local, peer)
          : await push(project, session, peerSync, peerMirror, local, peer);
      if (outcome.applied) {
        setAgreed(record, direction === "pull" ? core(peer) : core(local));
        setStatus(record, { status: "synced", detail: "" });
        return;
      }
      if (outcome.reason === "changed-locally") {
        // The side being written moved between our read and the
        // apply. Look again right away.
        trigger(record);
        return;
      }
      setStatus(record, { status: "blocked", detail: outcome.reason });
    } catch (error) {
      log(`[mirror] git follow ${session.session}: ${errorMessageOf(error)}`);
      setStatus(record, { status: "error", detail: errorMessageOf(error) });
    }
  }

  // Which side is the reference this round, or that neither may be.
  async function decide(
    project: Project,
    record: FollowRecord,
    local: GitState,
    peer: GitState,
    // The copy is the peer's (mirror:startTo), so the original is here.
    copyIsRemote: boolean,
  ): Promise<"pull" | "push" | "diverged"> {
    const agreed = record.agreed;
    if (agreed === null) {
      // Equal tips that still differ (the index): the original is the
      // reference, never the copy a dirty apply just rebuilt, whose
      // index starts out unstaged.
      if (local.tip === peer.tip) return copyIsRemote ? "push" : "pull";
      // The peer's tip is here only if a pull ever landed it (a fresh
      // session started by mirror:start always has it). An unknown or
      // unrelated tip is two histories.
      if (!(await hasCommit(project.path, peer.tip))) return "diverged";
      if (await isAncestor(project.path, local.tip, peer.tip)) return "pull";
      if (await isAncestor(project.path, peer.tip, local.tip)) return "push";
      return "diverged";
    }
    // Tips (and the branch) are what divergence is about. A side whose
    // tip moved is followed, its index included: a commit consumes the
    // staging on that side, and the other side's index-only changes
    // give way to it. Only when neither tip moved do the indexes
    // decide, and only both having changed is a divergence there.
    const localTipMoved =
      local.tip !== agreed.tip || !sameHead(local.head, agreed.head);
    const peerTipMoved =
      peer.tip !== agreed.tip || !sameHead(peer.head, agreed.head);
    if (localTipMoved && peerTipMoved) return "diverged";
    if (peerTipMoved) return "pull";
    if (localTipMoved) return "push";
    const localIndexMoved = local.indexTree !== agreed.indexTree;
    const peerIndexMoved = peer.indexTree !== agreed.indexTree;
    if (localIndexMoved && peerIndexMoved) return "diverged";
    if (peerIndexMoved) return "pull";
    return "push";
  }

  function describeDivergence(local: GitState, peer: GitState): string {
    const parts: string[] = [];
    if (local.tip !== peer.tip) parts.push("both sides have new commits");
    if (!sameHead(local.head, peer.head)) parts.push("different branches");
    if (parts.length === 0 && local.indexTree !== peer.indexTree) {
      parts.push("different staged changes on both sides");
    }
    return parts.join(", ") || "both sides changed";
  }

  // Carry the peer's state here.
  async function pull(
    project: Project,
    localWorktree: { id: string; path: string },
    session: FollowableSession,
    peerSync: PeerSyncApi,
    local: GitState,
    peer: GitState,
  ): Promise<Outcome> {
    const wantRefs: string[] = [];
    const sweep: string[] = [];
    const [tipIsLocal, indexCommitIsLocal] = await Promise.all([
      hasCommit(project.path, peer.tip),
      peer.indexCommit === null
        ? true
        : hasCommit(project.path, peer.indexCommit),
    ]);
    if (!tipIsLocal) {
      if (peer.head.kind !== "branch") {
        return {
          applied: false,
          reason:
            "the other device is on a detached HEAD at a commit not present here",
        };
      }
      wantRefs.push(`refs/heads/${peer.head.branch}`);
      sweep.push(`refs/shigomori/incoming/${peer.head.branch}`);
    }
    if (!indexCommitIsLocal) {
      wantRefs.push(indexRefFor(session.worktreeId));
      sweep.push(indexRefFor(session.worktreeId));
    }
    if (wantRefs.length > 0) {
      await fetchBundleFromPeer(peerSync, {
        sourceProjectId: session.projectId,
        targetProjectId: project.id,
        refs: wantRefs,
        // With the tip already here only the index carrier travels
        // and the tip is the perfect have. Otherwise every local
        // branch tip thins the bundle and none can cover a tip we
        // lack.
        haves: tipIsLocal ? [peer.tip] : await localBranchTips(project.path),
      });
    }
    return applyGitState(project, localWorktree, {
      expect: { tip: local.tip, indexTree: local.indexTree },
      state: core(peer),
      sweep,
    });
  }

  // Carry this side's state to the peer.
  async function push(
    project: Project,
    session: FollowableSession,
    peerSync: PeerSyncApi,
    peerMirror: PeerMirrorApi,
    local: GitState,
    peer: GitState,
  ): Promise<Outcome> {
    const probe = [
      local.tip,
      ...(local.indexCommit === null ? [] : [local.indexCommit]),
    ];
    const { present } = Schema.decodeUnknownSync(SyncHasCommitsResultSchema)(
      await peerSync.hasCommits({
        projectId: session.projectId,
        commits: probe,
      }),
    );
    const peerHas = new Set(present);
    const localWorktreeId = session.labels[LABEL_LOCAL_WORKTREE] ?? "";
    const wantRefs: string[] = [];
    const sweep: string[] = [];
    if (!peerHas.has(local.tip)) {
      if (local.head.kind !== "branch") {
        return {
          applied: false,
          reason:
            "this worktree is on a detached HEAD at a commit the other device does not have",
        };
      }
      wantRefs.push(`refs/heads/${local.head.branch}`);
      sweep.push(`refs/shigomori/incoming/${local.head.branch}`);
    }
    if (local.indexCommit !== null && !peerHas.has(local.indexCommit)) {
      wantRefs.push(indexRefFor(localWorktreeId));
      sweep.push(indexRefFor(localWorktreeId));
    }
    if (wantRefs.length > 0) {
      await pushBundleToPeer(peerSync, {
        localProject: project,
        peerProjectId: session.projectId,
        refs: wantRefs,
        haves: peerHas.has(local.tip) ? [local.tip] : [peer.tip],
      });
    }
    const result = Schema.decodeUnknownSync(MirrorApplyGitStateResultSchema)(
      await peerMirror.applyGitState({
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        expect: { tip: peer.tip, indexTree: peer.indexTree },
        state: core(local),
        sweep,
      }),
    );
    return result.applied
      ? { applied: true }
      : { applied: false, reason: result.reason ?? "refused" };
  }

  // Bring the followed set in line with the daemon's sessions: a new
  // session gets a record (seeded from the stored agreement) and an
  // index watcher, a gone one is dropped. Its stored agreement stays:
  // the daemon reports no sessions while it restarts, and the same
  // sessions come back a moment later. Only forget() below, on an
  // explicit terminate, drops the agreement. True when a session
  // came, went or flipped its pause.
  function syncSessions(): boolean {
    loadStored();
    const current = new Map(deps.sessions().map((s) => [s.session, s]));
    let changed = false;
    for (const [id, record] of records) {
      if (!current.has(id)) {
        record.stopIndexWatch?.();
        if (record.drain !== null) {
          Effect.runFork(Fiber.interrupt(record.drain));
        }
        records.delete(id);
        changed = true;
      }
    }
    for (const [id, session] of current) {
      const existing = records.get(id);
      if (existing !== undefined) {
        if (existing.session.paused !== session.paused) changed = true;
        existing.session = session;
        continue;
      }
      changed = true;
      const record: FollowRecord = {
        session,
        status: { status: "off", detail: "" },
        agreed: stored[id] ?? null,
        queue: null,
        early: false,
        drain: null,
        stopIndexWatch: null,
      };
      records.set(id, record);
      startDrain(record);
      void watchIndexFile(session.localRoot, () => trigger(record)).then(
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

  function reconcileAll(): void {
    syncSessions();
    for (const record of records.values()) trigger(record);
  }

  return {
    start(): void {
      reconcileAll();
      if (sweeper === null) {
        const every = deps.sweepMs ?? DEFAULT_SWEEP_MS;
        // The backstop: a look at every session each `every`, the
        // first one `every` from now (the start just looked).
        sweeper = Fiber.runIn(
          Effect.runFork(
            Effect.sync(() => {
              // Contained, for the drain's reason.
              try {
                reconcileAll();
              } catch (error) {
                log(`[mirror] git follow sweep: ${errorMessageOf(error)}`);
              }
            }).pipe(
              Effect.delay(every),
              Effect.repeat(Schedule.spaced(every)),
              Effect.asVoid,
            ),
          ),
          followScope(),
        );
      }
    },
    // Closes the follower's scope: the sweep and every session's drain
    // are interrupted. A later start (or a snapshot) opens a fresh one.
    stop(): void {
      for (const record of records.values()) record.stopIndexWatch?.();
      records.clear();
      sweeper = null;
      if (scope !== null) {
        Effect.runFork(Scope.close(scope, Exit.void));
        scope = null;
      }
    },
    // The daemon reported a snapshot: only a session coming, going or
    // flipping its pause is worth a re-look.
    sessionsChanged(): void {
      if (syncSessions()) {
        for (const record of records.values()) trigger(record);
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
    // live record if the daemon's snapshot already made one.
    rename(from: string, to: string): void {
      loadStored();
      const agreed = stored[from];
      if (agreed === undefined) return;
      delete stored[from];
      stored[to] = agreed;
      persist();
      const record = records.get(to);
      if (record !== undefined && record.agreed === null)
        record.agreed = agreed;
    },
    onLocalProjectChanged(projectId: string): void {
      syncSessions();
      triggerWhere((s) => s.labels[LABEL_LOCAL_PROJECT] === projectId);
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
