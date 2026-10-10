// The git follower's transfers (gitFollow.ts): carrying one side's
// state to the other, commits first through a bundle, then a
// compare-and-set apply on the side being written. And the one read the
// planner cannot do itself: ancestry, for two sides that never agreed.
//
// A mirror-branch session's state is judged in this side's names
// (followPlan.ts), but the transfers name each side's own branch: a
// pull asks for the peer's own head, a push lands this side's.
import type { Project } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { hasCommit, isAncestor, localBranchTips } from "@host/lib/git/refs";
import { offer, peerSource } from "@host/lib/sync/sourceLink";
import { peerMirrorFor, peerSyncFor } from "@host/ipc/peerSync";
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

export const chooseDirection = Effect.fnUntraced(function* (
  projectPath: string,
  agreed: GitStateCore | null,
  local: GitState,
  peer: GitState,
) {
  const planned = decide(agreed, local, peer);
  if (planned !== "ancestry") return planned;
  if (!(yield* hasCommit(projectPath, peer.tip))) return "diverged";
  if (yield* isAncestor(projectPath, local.tip, peer.tip)) return "pull";
  if (yield* isAncestor(projectPath, peer.tip, local.tip)) return "push";
  return "diverged" as Direction;
});

export interface Round {
  readonly project: Project;
  readonly localWorktree: { id: string; path: string };
  readonly session: FollowableSession;
  readonly local: GitState;
  readonly peer: GitState;
}

const pullHaves = Effect.fnUntraced(function* (
  projectPath: string,
  localTip: string,
  agreedTip: string | null,
) {
  const [agreedHere, branchTips] = yield* Effect.all(
    [
      agreedTip === null || agreedTip === localTip
        ? Effect.succeed(false)
        : hasCommit(projectPath, agreedTip),
      localBranchTips(projectPath),
    ],
    { concurrency: 2 },
  );
  const first =
    agreedHere && agreedTip !== null ? [localTip, agreedTip] : [localTip];
  return [...new Set([...first, ...branchTips])].slice(0, 256);
});

export const pull = Effect.fnUntraced(function* (
  { project, localWorktree, session, local, peer }: Round,
  peerHead: GitHead,
  agreedTip: string | null,
) {
  const [tipIsLocal, indexCommitIsLocal] = yield* Effect.all(
    [
      hasCommit(project.path, peer.tip),
      peer.indexCommit === null
        ? Effect.succeed(true)
        : hasCommit(project.path, peer.indexCommit),
    ],
    { concurrency: 2 },
  );
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
      : yield* pullHaves(project.path, local.tip, agreedTip);
    yield* Effect.scoped(
      Effect.flatMap(
        peerSource(session.deviceId, {
          projectId: session.projectId,
          worktreeId: session.worktreeId,
        }),
        (source) => source.fetch({ refs: wantRefs, haves, into: project }),
      ),
    );
  }
  const result = yield* applyGitState(project, localWorktree, {
    expect: { tip: local.tip, indexTree: local.indexTree },
    state: core(peer),
    sweep,
  });
  return (
    result.applied || result.reason === CHANGED_LOCALLY
      ? result
      : { applied: false, reason: describeRefusal(result.reason, "here") }
  ) as Outcome;
});

export const push = Effect.fnUntraced(function* (
  { project, localWorktree, session, local, peer }: Round,
  headThere: GitHead,
) {
  const probe = [
    local.tip,
    ...(local.indexCommit === null ? [] : [local.indexCommit]),
  ];
  const peerSync = peerSyncFor(session.deviceId);
  const { present } = yield* peerSync.hasCommits({
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
    yield* offer(session.deviceId, project, localWorktree.id, (channelId) =>
      peerSync.receiveBundle({
        projectId: session.projectId,
        refs: wantRefs,
        haves: peerHas.has(local.tip) ? [local.tip] : [peer.tip],
        channelId,
      }),
    );
  }
  const result = yield* peerMirrorFor(session.deviceId).applyGitState({
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    expect: { tip: peer.tip, indexTree: peer.indexTree },
    state: { ...core(local), head: headThere },
    sweep,
  });
  if (result.applied) return { applied: true } as Outcome;
  const reason = result.reason ?? "refused";
  return (
    reason === CHANGED_LOCALLY
      ? { applied: false, reason }
      : { applied: false, reason: describeRefusal(reason, "there") }
  ) as Outcome;
});
