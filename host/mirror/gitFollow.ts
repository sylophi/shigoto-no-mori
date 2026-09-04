// The git follower: for every mirror session this device runs, keeps
// the git state of the local worktree and the peer's worktree the same
// (host/mirror/gitState.ts defines that state), so a commit, a stage,
// a checkout or a reset on either machine shows up on the other within
// a moment. The file-sync engine owns the files; this owns HEAD, the
// tip and the staged tree.
//
// One rule decides direction, and it is the rule that makes the
// follower safe: a side is followed only if the OTHER side has not
// moved since the two last agreed. The follower remembers the state
// both sides last shared. If only the peer moved, the peer's state is
// carried here (commits through the existing bundle pull, then a
// compare-and-set apply). If only this side moved, it is carried to
// the peer (a bundle push, then the peer's apply). If both moved, the
// session is reported diverged and neither side is touched until the
// user resolves it; the same holds for a branch collision the apply
// refuses. Because "moved since we agreed" rather than ancestry is the
// test, an amend or a rebase on one side follows cleanly as long as
// the other side stayed put.
//
// Before the two sides have ever agreed (a session just created), the
// peer is taken as the reference when the tips are equal or the local
// tip is an ancestor of the peer's, which is exactly the state
// mirror:start leaves behind (a pull, then a mirror); anything else is
// diverged from the start.
//
// Signals: the local git-directory watcher (a project ping), a local
// index watcher per session, the peer's git:projectChanged and
// mirror:gitChanged pushes, every daemon snapshot (new or gone
// sessions) and a slow periodic sweep as the backstop. Reconciles are
// coalesced per session: one in flight, one queued.
import type { Project } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import {
  GitStateSchema,
  type MirrorGitStatus,
  MirrorApplyGitStateResultSchema,
} from "@shared/ipc/modules/mirror";
import { SyncHasCommitsResultSchema } from "@shared/ipc/modules/sync";
import { hasCommit, localBranchTips } from "@host/lib/git/refs";
import { findProjectOrThrow } from "@host/lib/projects";
import { fetchBundleFromPeer } from "@host/lib/sync/fetchBundle";
import { pushBundleToPeer } from "@host/lib/sync/pushBundle";
import type { PeerMirrorApi, PeerSyncApi } from "@host/ipc/peerSync";
import {
  applyGitState,
  type GitHead,
  type GitState,
  type GitStateCore,
  indexRefFor,
  readGitState,
  watchIndexFile,
} from "./gitState";
import { run } from "@host/lib/git/core";

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

// The label keys mirror:start writes (host/ipc/modules/mirror.ts).
const LABEL_LOCAL_PROJECT = "localProjectId";
const LABEL_LOCAL_WORKTREE = "localWorktreeId";

type Agreed = GitStateCore;

type FollowRecord = {
  session: FollowableSession;
  status: MirrorGitStatus;
  agreed: Agreed | null;
  running: boolean;
  pending: boolean;
  stopIndexWatch: (() => void) | null;
};

const DEFAULT_SWEEP_MS = 15_000;

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

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await run(cwd, [
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestor,
      descendant,
    ]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

export type GitFollower = ReturnType<typeof createGitFollower>;

export function createGitFollower(deps: {
  sessions: () => FollowableSession[];
  peerSyncApiFor: (deviceId: string) => PeerSyncApi;
  peerMirrorApiFor: (deviceId: string) => PeerMirrorApi;
  // Fires when any session's git status changes.
  onChange?: () => void;
  sweepMs?: number;
  log?: (message: string) => void;
}) {
  const records = new Map<string, FollowRecord>();
  const log = deps.log ?? ((message: string) => console.warn(message));
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

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

  function trigger(record: FollowRecord): void {
    if (record.running) {
      record.pending = true;
      return;
    }
    record.running = true;
    void (async () => {
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
        record.running = false;
      }
    })();
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
      const local = await readGitState(
        project.path,
        localWorktree.path,
        localWorktree.id,
      );
      const peer = GitStateSchema.parse(
        await peerMirror.gitState({
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        }),
      );
      if (sameState(local, peer)) {
        record.agreed = core(peer);
        setStatus(record, { status: "synced", detail: "" });
        return;
      }

      const direction = await decide(project, record, local, peer);
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
        record.agreed = direction === "pull" ? core(peer) : core(local);
        setStatus(record, { status: "synced", detail: "" });
        return;
      }
      if (outcome.reason === "changed-locally") {
        // The side being written moved between our read and the
        // apply. Look again right away.
        record.pending = true;
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
  ): Promise<"pull" | "push" | "diverged"> {
    const agreed = record.agreed;
    if (agreed === null) {
      if (local.tip === peer.tip) return "pull";
      if (
        (await hasCommit(project.path, peer.tip)) &&
        (await isAncestor(project.path, local.tip, peer.tip))
      ) {
        return "pull";
      }
      if (
        (await hasCommit(project.path, peer.tip)) &&
        (await isAncestor(project.path, peer.tip, local.tip))
      ) {
        return "push";
      }
      // The peer's tip is unknown here (never fetched) or unrelated:
      // fetching it is what a pull does, and a fresh session started
      // by mirror:start always has the peer's tip, so anything else is
      // two histories.
      return "diverged";
    }
    const localMoved = !sameState(local, agreed);
    const peerMoved = !sameState(peer, agreed);
    if (localMoved && peerMoved) return "diverged";
    if (peerMoved) return "pull";
    return "push";
  }

  function describeDivergence(local: GitState, peer: GitState): string {
    const parts: string[] = [];
    if (local.tip !== peer.tip) parts.push("both sides have new commits");
    if (!sameHead(local.head, peer.head)) parts.push("different branches");
    if (local.indexTree !== peer.indexTree)
      parts.push("different staged changes");
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
  ): Promise<{ applied: true } | { applied: false; reason: string }> {
    const wantRefs: string[] = [];
    const sweep: string[] = [];
    const tipIsLocal = await hasCommit(project.path, peer.tip);
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
    if (
      peer.indexCommit !== null &&
      !(await hasCommit(project.path, peer.indexCommit))
    ) {
      wantRefs.push(indexRefFor(session.worktreeId));
      sweep.push(indexRefFor(session.worktreeId));
    }
    if (wantRefs.length > 0) {
      await fetchBundleFromPeer(peerSync, {
        sourceProjectId: session.projectId,
        targetProjectId: project.id,
        refs: wantRefs,
        // With the tip already here only the index carrier travels
        // and the tip is the perfect have; otherwise every local
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
  ): Promise<{ applied: true } | { applied: false; reason: string }> {
    const probe = [
      local.tip,
      ...(local.indexCommit === null ? [] : [local.indexCommit]),
    ];
    const { present } = SyncHasCommitsResultSchema.parse(
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
    const result = MirrorApplyGitStateResultSchema.parse(
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
  // session gets a record and an index watcher, a gone one is dropped.
  function syncSessions(): void {
    const current = new Map(deps.sessions().map((s) => [s.session, s]));
    for (const [id, record] of records) {
      if (!current.has(id)) {
        record.stopIndexWatch?.();
        records.delete(id);
        deps.onChange?.();
      }
    }
    for (const [id, session] of current) {
      const existing = records.get(id);
      if (existing !== undefined) {
        existing.session = session;
        continue;
      }
      const record: FollowRecord = {
        session,
        status: { status: "off", detail: "" },
        agreed: null,
        running: false,
        pending: false,
        stopIndexWatch: null,
      };
      records.set(id, record);
      void watchIndexFile(session.localRoot, () => trigger(record)).then(
        (stop) => {
          if (records.get(id) === record) record.stopIndexWatch = stop;
          else stop();
        },
        () => {},
      );
    }
  }

  function reconcileAll(): void {
    syncSessions();
    for (const record of records.values()) trigger(record);
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
    // The daemon reported a snapshot: sessions may have come or gone,
    // and a re-look costs one round trip per session.
    sessionsChanged: reconcileAll,
    onLocalProjectChanged(projectId: string): void {
      syncSessions();
      for (const record of records.values()) {
        if (record.session.labels[LABEL_LOCAL_PROJECT] === projectId) {
          trigger(record);
        }
      }
    },
    onPeerProjectChanged(deviceId: string, projectId: string): void {
      for (const record of records.values()) {
        if (
          record.session.deviceId === deviceId &&
          record.session.projectId === projectId
        ) {
          trigger(record);
        }
      }
    },
    onPeerWorktreeChanged(
      deviceId: string,
      projectId: string,
      worktreeId: string,
    ): void {
      for (const record of records.values()) {
        if (
          record.session.deviceId === deviceId &&
          record.session.projectId === projectId &&
          record.session.worktreeId === worktreeId
        ) {
          trigger(record);
        }
      }
    },
    statusOf(session: string): MirrorGitStatus | undefined {
      return records.get(session)?.status;
    },
  };
}
