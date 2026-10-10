// The git follower's decisions (gitFollow.ts): given the state both
// sides last agreed on and what each side reads now, which way git
// follows, what a transfer carries, and how a refusal or a divergence
// reads. Pure: the reads and the transfers are followTransfer.ts's.
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
// A primary checkout's mirror (its mode is mirror-branch) has
// its copy on mirror/<branch> for whatever branch the original is on
// (contracts' git/branches.ts). The original is here, so the follower
// reads the peer's state with the mirror/ prefix taken off and sends
// this side's with it put on, and everything else here (agreement,
// divergence, the apply) works on one name per side.
import type { MirrorStatus } from "@shigomori/contracts/modules/mirror";
import {
  mirrorBranchFor,
  originalBranchOf,
} from "@shigomori/contracts/git/branches";
import {
  type GitHead,
  type GitState,
  type GitStateCore,
  operationInRefusal,
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

// How a session's branch names translate between its two sides: the
// original's branch here is the copy's mirror branch there, and back.
// Identity for a session with no mirror branch. Null when the copy's
// branch has no mirror/ prefix, which the follower reports rather
// than follows.
type BranchNames = {
  toLocal: (head: GitHead) => GitHead | null;
  toPeer: (head: GitHead) => GitHead | null;
};
export const SAME_NAMES: BranchNames = {
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
export const OFF_MIRROR_BRANCH =
  "the copy is on a branch without the mirror/ prefix. Check out a mirror/ branch there to keep following";

export const MIRROR_NAMES: BranchNames = {
  toLocal: rename(originalBranchOf),
  toPeer: rename(mirrorBranchFor),
};

// The apply's refusal when the side being written moved since it was
// read. Never shown: the follower looks again at once.
export const CHANGED_LOCALLY = "changed-locally";

export type Side = "here" | "there";

function whereIs(side: Side): string {
  return side === "here" ? "here" : "on the other device";
}

export function operationDetail(operation: string, side: Side): string {
  return `a ${operation} is in progress ${whereIs(side)}. Git follows again once it finishes`;
}

// An apply's refusal as the runner's status shows it. A refusal made by
// the peer's apply speaks from the peer ("on this device"), so its
// devices trade places here. The bare tokens become sentences.
export function describeRefusal(reason: string, side: Side): string {
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

export function sameHead(a: GitHead, b: GitHead): boolean {
  return a.kind === "branch" && b.kind === "branch"
    ? a.branch === b.branch
    : a.kind === b.kind;
}

export function sameState(a: GitStateCore, b: GitStateCore): boolean {
  return (
    a.tip === b.tip && a.indexTree === b.indexTree && sameHead(a.head, b.head)
  );
}

export function core(state: GitState): GitStateCore {
  return { head: state.head, tip: state.tip, indexTree: state.indexTree };
}

export type Outcome = { applied: true } | { applied: false; reason: string };

// The refs a bundle carries so the receiving side can land a state, and
// the landing refs to sweep after the apply: the branch when the tip is
// missing there (a detached tip has no ref to travel under, so that
// refuses with `detachedReason`), and the index carrier `indexRef` when
// its commit is missing there too (null otherwise).
export function refsToCarry(
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

export type Direction = "pull" | "push" | "diverged";

// Which side is the reference this round, or that neither may be.
// Before the two sides have ever agreed, ancestry decides, which needs
// git: "ancestry" asks the caller to look.
export function decide(
  agreed: GitStateCore | null,
  local: GitState,
  peer: GitState,
): Direction | "ancestry" {
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
    // Otherwise the histories decide (followTransfer.ts byAncestry).
    return "ancestry";
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

export function describeDivergence(local: GitState, peer: GitState): string {
  const parts: string[] = [];
  if (local.tip !== peer.tip) parts.push("both sides have new commits");
  if (!sameHead(local.head, peer.head)) parts.push("different branches");
  if (parts.length === 0 && local.indexTree !== peer.indexTree) {
    parts.push("different staged changes on both sides");
  }
  return parts.join(", ") || "both sides changed";
}
