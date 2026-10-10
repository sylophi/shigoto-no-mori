// The git follower's transfers (gitFollow.ts): carrying one side's
// state to the other, commits first through a bundle, then a
// compare-and-set apply on the side being written. And the one read the
// planner cannot do itself: ancestry, for two sides that never agreed.
//
// A mirror-branch session's state is judged in this side's names
// (followPlan.ts), but the transfers name each side's own branch: a
// pull asks for the peer's own head, a push lands this side's.
import type { Project } from "@shigomori/contracts/schemas";
import type * as Engine from "@host/lib/engine";
import { hasCommit, isAncestor, localBranchTips } from "@host/lib/git/promises";
import { offerSource, withPeerSource } from "@host/lib/sync/sourceLink";
import type { PeerMirrorApi, PeerSyncApi } from "@host/ipc/peerSync";
import {
  CHANGED_LOCALLY,
  core,
  decide,
  describeRefusal,
  type Direction,
  type FollowableSession,
  type Outcome,
  refsToCarry,
} from "./followPlan";
import {
  applyGitState,
  type GitHead,
  type GitState,
  type GitStateCore,
  indexRefFor,
} from "./gitState";

// Which way git follows this round (followPlan.ts decide), looking at
// the histories for two sides that never agreed and sit on different
// tips. The peer's tip is here only if it ever landed here: an unknown
// or unrelated tip is two histories.
export async function chooseDirection(
  projectPath: string,
  agreed: GitStateCore | null,
  local: GitState,
  peer: GitState,
): Promise<Direction> {
  const planned = decide(agreed, local, peer);
  if (planned !== "ancestry") return planned;
  if (!(await hasCommit(projectPath, peer.tip))) return "diverged";
  if (await isAncestor(projectPath, local.tip, peer.tip)) return "pull";
  if (await isAncestor(projectPath, peer.tip, local.tip)) return "push";
  return "diverged";
}

// One reconcile's view: the session, its two sides' APIs, and the
// state each side read. `peer` is in this side's branch names.
export interface Round {
  readonly project: Project;
  readonly localWorktree: { id: string; path: string };
  readonly session: FollowableSession;
  readonly peerSync: PeerSyncApi;
  readonly peerMirror: PeerMirrorApi;
  readonly local: GitState;
  readonly peer: GitState;
  // The engine the bundles are made and unpacked on.
  readonly engine: Engine.Handle;
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

// Carry the peer's state here. `peer` is in this side's names and is
// what lands. `peerHead` is the peer's own, which the bundle is asked
// for. `agreedTip` is the tip both sides last shared, the best have
// after this side's own.
export async function pull(
  { project, localWorktree, session, peerSync, local, peer, engine }: Round,
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
      engine,
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
export async function push(
  {
    project,
    localWorktree,
    session,
    peerSync,
    peerMirror,
    local,
    peer,
    engine,
  }: Round,
  headThere: GitHead,
): Promise<Outcome> {
  const probe = [
    local.tip,
    ...(local.indexCommit === null ? [] : [local.indexCommit]),
  ];
  const { present } = await peerSync.hasCommits({
    projectId: session.projectId,
    commits: probe,
  });
  const peerHas = new Set(present);
  const carry = refsToCarry(
    local.head,
    !peerHas.has(local.tip),
    local.indexCommit !== null && !peerHas.has(local.indexCommit)
      ? indexRefFor(localWorktree.id)
      : null,
    "this worktree is on a detached HEAD at a commit the other device does not have",
  );
  if ("applied" in carry) return carry;
  const { wantRefs, sweep } = carry;
  if (wantRefs.length > 0) {
    // The peer asks this side for the bundle over a link this side
    // opens (sync:receiveBundle, the peer's grant, the one the whole
    // session rides).
    await offerSource(
      peerSync,
      project,
      localWorktree.id,
      (channelId) =>
        peerSync.receiveBundle({
          projectId: session.projectId,
          refs: wantRefs,
          haves: peerHas.has(local.tip) ? [local.tip] : [peer.tip],
          channelId,
        }),
      engine,
    );
  }
  const result = await peerMirror.applyGitState({
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    expect: { tip: peer.tip, indexTree: peer.indexTree },
    state: { ...core(local), head: headThere },
    sweep,
  });
  if (result.applied) return { applied: true };
  const reason = result.reason ?? "refused";
  return reason === CHANGED_LOCALLY
    ? { applied: false, reason }
    : { applied: false, reason: describeRefusal(reason, "there") };
}
