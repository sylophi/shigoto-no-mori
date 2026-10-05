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
// agreement), ancestry decides. A session runs on the device holding
// the original, so on equal tips the original here is the reference,
// never the copy a dirty apply just rebuilt. This side is the
// reference when the peer's tip is an ancestor of the local one, the
// peer when it is the other way round. Anything else is diverged from
// the start.
//
// A primary checkout's mirror (the session's mirrorBranch label) has
// its copy on mirror/<branch> for whatever branch the original is on
// (shared/git/branches.ts). The original is here, so the follower
// reads the peer's state with the mirror/ prefix taken off and sends
// this side's with it put on, and everything else here (agreement,
// divergence, the apply) works on one name per side. The transfers
// still name each side's own branch.
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
import type { Project } from "@shared/schemas";
import { errorMessageOf, isEntityGoneError } from "@shared/errors";
import {
  GitStateSchema,
  isHaltedStatus,
  MIRROR_LABEL_REPLACES,
  type MirrorGitStatus,
  MirrorApplyGitStateResultSchema,
  mirrorOnMirrorBranch,
  type MirrorStatus,
} from "@shared/ipc/modules/mirror";
import { mirrorBranchFor, originalBranchOf } from "@shared/git/branches";
import { SyncHasCommitsResultSchema } from "@shared/ipc/modules/sync";
import { hasCommit, isAncestor, localBranchTips } from "@host/lib/git/refs";
import { findProjectOrThrow } from "@host/lib/projects";
import { offerSource, withPeerSource } from "@host/lib/sync/sourceLink";
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
  operationInRefusal,
  readGitState,
  watchIndexFile,
} from "./gitState";

// The slice of a daemon session the follower reads. `status` is the
// file-sync engine's own (watching is idle, everything else is a cycle
// under way, a connection being made or a halt).
export type FollowableSession = {
  session: string;
  paused: boolean;
  status: MirrorStatus;
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

// How a session's branch names translate between its two sides: the
// original's branch here is the copy's mirror branch there, and back.
// Identity for a session with no mirror branch. Null when the copy's
// branch has no mirror/ prefix, which the follower reports rather
// than follows.
type BranchNames = {
  toLocal: (head: GitHead) => GitHead | null;
  toPeer: (head: GitHead) => GitHead | null;
};
const SAME_NAMES: BranchNames = {
  toLocal: (head) => head,
  toPeer: (head) => head,
};
const rename =
  (map: (branch: string) => string | null) =>
  (head: GitHead): GitHead | null => {
    if (head.kind !== "branch") return head;
    const branch = map(head.branch);
    return branch === null ? null : { kind: "branch", branch };
  };
const OFF_MIRROR_BRANCH =
  "the copy is on a branch without the mirror/ prefix. Check out a mirror/ branch there to keep following";

const MIRROR_NAMES: BranchNames = {
  toLocal: rename(originalBranchOf),
  toPeer: rename(mirrorBranchFor),
};

// The label keys mirror:startTo writes.
const LABEL_LOCAL_PROJECT = MIRROR_LABEL_LOCAL_PROJECT;
const LABEL_LOCAL_WORKTREE = MIRROR_LABEL_LOCAL_WORKTREE;

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

// The apply's refusal when the side being written moved since it was
// read. Never shown: the follower looks again at once.
const CHANGED_LOCALLY = "changed-locally";

type Side = "here" | "there";

function whereIs(side: Side): string {
  return side === "here" ? "here" : "on the other device";
}

function operationDetail(operation: string, side: Side): string {
  return `a ${operation} is in progress ${whereIs(side)}. Git follows again once it finishes`;
}

// An apply's refusal as the runner's status shows it. A refusal made by
// the peer's apply speaks from the peer ("on this device"), so its
// devices trade places here. The bare tokens become sentences.
function describeRefusal(reason: string, side: Side): string {
  const operation = operationInRefusal(reason);
  if (operation !== null) return operationDetail(operation, side);
  if (reason === "missing-objects") {
    return side === "here"
      ? "this device is missing commits the other device's state needs"
      : "the other device is missing commits this device's state needs";
  }
  if (side === "here") return reason;
  if (reason === "refused") return "the other device refused the change";
  return reason.replace(/this device|the other device/g, (match) =>
    match === "this device" ? "the other device" : "this device",
  );
}

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

// The refs a bundle carries so the receiving side can land a state, and
// the landing refs to sweep after the apply: the branch when the tip is
// missing there (a detached tip has no ref to travel under, so that
// refuses with `detachedReason`), and the index carrier `indexRef` when
// its commit is missing there too (null otherwise).
function refsToCarry(
  head: GitHead,
  tipMissing: boolean,
  indexRef: string | null,
  detachedReason: string,
): Outcome | { wantRefs: string[]; sweep: string[] } {
  const wantRefs: string[] = [];
  const sweep: string[] = [];
  if (tipMissing) {
    if (head.kind !== "branch") {
      return { applied: false, reason: detachedReason };
    }
    wantRefs.push(`refs/heads/${head.branch}`);
    sweep.push(`refs/shigomori/incoming/${head.branch}`);
  }
  if (indexRef !== null) {
    wantRefs.push(indexRef);
    sweep.push(indexRef);
  }
  return { wantRefs, sweep };
}

// Neither tip moved (or both sides already share one): the indexes
// decide, and only both having changed is a divergence.
function decideIndex(
  agreed: GitStateCore,
  local: GitState,
  peer: GitState,
): "pull" | "push" | "diverged" {
  const localIndexMoved = local.indexTree !== agreed.indexTree;
  const peerIndexMoved = peer.indexTree !== agreed.indexTree;
  if (localIndexMoved && peerIndexMoved) return "diverged";
  if (peerIndexMoved) return "pull";
  return "push";
}

// The haves for a pull whose tip is not here (see pull).
async function pullHaves(
  projectPath: string,
  localTip: string,
  agreedTip: string | null,
): Promise<string[]> {
  const [agreedHere, branchTips] = await Promise.all([
    agreedTip === null || agreedTip === localTip
      ? false
      : hasCommit(projectPath, agreedTip),
    localBranchTips(projectPath),
  ]);
  const first =
    agreedHere && agreedTip !== null ? [localTip, agreedTip] : [localTip];
  return [...new Set([...first, ...branchTips])].slice(0, 256);
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
  // The peer answered that the session's copy is not a worktree it
  // lists (deleted, moved, or re-created where its id points elsewhere,
  // none of which announced itself here). A peer that is merely away
  // answers nothing and is no such report. At most once a minute per
  // session.
  onCopyGone?: (session: FollowableSession) => void;
  // A pull landed here: refs, HEAD and the index moved in the local
  // project by the app's own git, which the git-directory watcher
  // skips as the app's own writes, so nothing else would tell this
  // device's pages (and its viewers) that the worktree moved.
  onLocalApplied?: (localProjectId: string) => void;
}) {
  const records = new Map<string, FollowRecord>();
  const copyGoneAt = new Map<string, number>();
  const log = deps.log ?? ((message: string) => console.warn(message));
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
      log(
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
    const localProjectId = session.labels[LABEL_LOCAL_PROJECT] ?? "";
    const localWorktreeId = session.labels[LABEL_LOCAL_WORKTREE] ?? "";
    let project: Project;
    try {
      project = await findProjectOrThrow(localProjectId);
    } catch (error) {
      setStatus(record, { status: "error", detail: errorMessageOf(error) });
      return;
    }
    const localWorktree = { id: localWorktreeId, path: session.localRoot };
    const peerSync = deps.peerSyncApiFor(session.deviceId);
    const peerMirror = deps.peerMirrorApiFor(session.deviceId);
    const names = mirrorOnMirrorBranch(session) ? MIRROR_NAMES : SAME_NAMES;
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
      const peerAsIs = GitStateSchema.parse(peerRead.value);
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

      const direction = await decide(project, record, local, peer);
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

      const outcome =
        direction === "pull"
          ? await pull(
              project,
              localWorktree,
              session,
              peerSync,
              local,
              peer,
              peerAsIs.head,
              record.agreed?.tip ?? null,
            )
          : await push(
              project,
              session,
              peerSync,
              peerMirror,
              local,
              peer,
              headThere,
            );
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
    // Already on one tip and branch: only the indexes can differ. This
    // is also how a half-landed apply heals (the ref moved, then
    // read-tree failed on a held index lock): judged by tips, that side
    // would read as moved too, and the session as diverged.
    if (
      agreed !== null &&
      local.tip === peer.tip &&
      sameHead(local.head, peer.head)
    ) {
      return decideIndex(agreed, local, peer);
    }
    if (agreed === null) {
      // Equal tips that still differ (the index): the original here is
      // the reference, never the copy a dirty apply just rebuilt, whose
      // index starts out unstaged.
      if (local.tip === peer.tip) return "push";
      // The peer's tip is here only if it ever landed here. An unknown
      // or unrelated tip is two histories.
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
    return decideIndex(agreed, local, peer);
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

  // Carry the peer's state here. `peer` is in this side's names and is
  // what lands. `peerHead` is the peer's own, which the bundle is asked
  // for. `agreedTip` is the tip both sides last shared, the best have
  // after this side's own.
  async function pull(
    project: Project,
    localWorktree: { id: string; path: string },
    session: FollowableSession,
    peerSync: PeerSyncApi,
    local: GitState,
    peer: GitState,
    peerHead: GitHead,
    agreedTip: string | null,
  ): Promise<Outcome> {
    const [tipIsLocal, indexCommitIsLocal] = await Promise.all([
      hasCommit(project.path, peer.tip),
      peer.indexCommit === null
        ? true
        : hasCommit(project.path, peer.indexCommit),
    ]);
    const carry = refsToCarry(
      peerHead,
      !tipIsLocal,
      indexCommitIsLocal ? null : indexRefFor(session.worktreeId),
      "the other device is on a detached HEAD at a commit not present here",
    );
    if ("applied" in carry) return carry;
    const { wantRefs, sweep } = carry;
    if (wantRefs.length > 0) {
      // With the tip already here only the index carrier travels and
      // the tip is the perfect have. Otherwise this side's tip and the
      // agreed one come first, since the peer's new tip most likely
      // grew from one of them, and the branch tips (alphabetical, and
      // cut at the contract's 256) fill the rest. The agreed tip goes
      // in only while it is still here: a have this side lacks would
      // thin away objects the bundle has to carry.
      const haves = tipIsLocal
        ? [peer.tip]
        : await pullHaves(project.path, local.tip, agreedTip);
      await withPeerSource(
        peerSync,
        { projectId: session.projectId, worktreeId: session.worktreeId },
        (source) => source.fetch({ refs: wantRefs, haves, into: project }),
      );
    }
    const result = await applyGitState(project, localWorktree, {
      expect: { tip: local.tip, indexTree: local.indexTree },
      state: core(peer),
      sweep,
    });
    return result.applied || result.reason === CHANGED_LOCALLY
      ? result
      : { applied: false, reason: describeRefusal(result.reason, "here") };
  }

  // Carry this side's state to the peer. The bundle names this side's
  // branch (it lands under the peer's incoming namespace by that name),
  // and the state applied there carries `headThere`, this side's head
  // in the peer's names.
  async function push(
    project: Project,
    session: FollowableSession,
    peerSync: PeerSyncApi,
    peerMirror: PeerMirrorApi,
    local: GitState,
    peer: GitState,
    headThere: GitHead,
  ): Promise<Outcome> {
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
    const carry = refsToCarry(
      local.head,
      !peerHas.has(local.tip),
      local.indexCommit !== null && !peerHas.has(local.indexCommit)
        ? indexRefFor(localWorktreeId)
        : null,
      "this worktree is on a detached HEAD at a commit the other device does not have",
    );
    if ("applied" in carry) return carry;
    const { wantRefs, sweep } = carry;
    if (wantRefs.length > 0) {
      // The peer asks this side for the bundle over a link this side
      // opens (sync:receiveBundle, the peer's grant, the one the whole
      // session rides).
      await offerSource(peerSync, project, localWorktreeId, (channelId) =>
        peerSync.receiveBundle({
          projectId: session.projectId,
          refs: wantRefs,
          haves: peerHas.has(local.tip) ? [local.tip] : [peer.tip],
          channelId,
        }),
      );
    }
    const result = MirrorApplyGitStateResultSchema.parse(
      await peerMirror.applyGitState({
        projectId: session.projectId,
        worktreeId: session.worktreeId,
        expect: { tip: peer.tip, indexTree: peer.indexTree },
        state: { ...core(local), head: headThere },
        sweep,
      }),
    );
    if (result.applied) return { applied: true };
    const reason = result.reason ?? "refused";
    return reason === CHANGED_LOCALLY
      ? { applied: false, reason }
      : { applied: false, reason: describeRefusal(reason, "there") };
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
