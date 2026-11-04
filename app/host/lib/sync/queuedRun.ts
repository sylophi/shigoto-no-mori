// A queued move's run (MoveQueue.ts), once the other device is back:
// what the dialog would have started, on the choices it was queued
// with, the leave-out rule resolved now over the source's own rules,
// then a transplant's source settled as asked, the way the terminal's
// send and bring settle theirs (receipts.ts). Nobody is watching,
// so the progress goes nowhere: the outcome is the queue's state.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { pullWorktreeName } from "@shigomori/contracts/git/branches";
import {
  type IgnoreSelection,
  needsIgnoredList,
  resolveIgnores,
  selectionOfPreset,
} from "@shigomori/contracts/leaveOutRule";
import type {
  SyncQueuedMove,
  SyncQueueMovePayload,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import * as Git from "@shigomori/engine/Git";
import * as DeviceId from "@host/lib/config/DeviceId";
import { peerSyncFor, peerWorktree } from "@host/ipc/PeerReach";
import { findProjectAndWorktree } from "@host/lib/projects";
import { startMirrorFrom, startMirrorTo } from "@host/mirror/sessions";
import { pullWorktree, sendWorktree } from "./move";
import { pullSettle, sendSettle, settleSource } from "./receipts";

class QueuedSourceGoneError extends Schema.TaggedError<QueuedSourceGoneError>()(
  "QueuedSourceGoneError",
  {},
) {
  override get message(): string {
    return "The worktree is no longer on the other device.";
  }
}

// What the queue keeps of a run that went through.
type QueuedOutcome = Omit<
  Extract<SyncQueuedMove["state"], { status: "done" }>,
  "status"
>;

// A run with no caller: its pushes reach nobody, and nothing aborts it
// but the queue's own drop.
const unattended: HandlerContext = {
  notifier: () => () => {},
  connection: new AbortController().signal,
};

const choiceOf = (
  move: SyncQueueMovePayload,
  selection: IgnoreSelection,
  patterns: readonly string[],
) => ({
  ...resolveIgnores(selection, { paths: [], total: 0, patterns }),
  runSetup: move.runSetup,
  ...(move.cloneInto === undefined ? {} : { cloneInto: move.cloneInto }),
});

const settled = <R>(
  move: SyncQueueMovePayload,
  landed: QueuedOutcome["landed"],
  settle: Parameters<typeof settleSource<R>>[1],
) =>
  Effect.map(
    settleSource(move.source ?? "keep", settle),
    (source): QueuedOutcome =>
      source.error === undefined
        ? { landed }
        : { landed, sourceError: source.error },
  );

const sendQueued = Effect.fnUntraced(function* (
  move: SyncQueueMovePayload,
  selection: IgnoreSelection,
) {
  const { project, worktree } = yield* findProjectAndWorktree(
    move.projectId,
    move.worktreeId,
  );
  const patterns = needsIgnoredList(selection)
    ? yield* (yield* Git.Git).listIgnoreRules(worktree.path)
    : [];
  const payload = {
    targetDeviceId: move.deviceId,
    projectId: project.id,
    worktreeId: worktree.id,
    ...choiceOf(move, selection, patterns),
  };
  if (move.kind === "mirror") {
    const sent = yield* startMirrorTo(payload, unattended);
    return {
      landed: {
        deviceId: move.deviceId,
        projectId: sent.worktree.projectId,
        worktreeId: sent.worktree.id,
      },
    } satisfies QueuedOutcome;
  }
  const { result } = yield* sendWorktree(payload, unattended);
  return yield* settled(
    move,
    {
      deviceId: move.deviceId,
      projectId: result.worktree.projectId,
      worktreeId: result.worktree.id,
    },
    sendSettle(move, worktree, unattended),
  );
});

const pullQueued = Effect.fnUntraced(function* (
  move: SyncQueueMovePayload,
  selection: IgnoreSelection,
) {
  const source = yield* peerWorktree(
    move.deviceId,
    move.projectId,
    move.worktreeId,
  );
  if (source === undefined) return yield* new QueuedSourceGoneError();
  const patterns = needsIgnoredList(selection)
    ? (yield* peerSyncFor(move.deviceId).ignoredPaths({
        projectId: move.projectId,
        worktreeId: move.worktreeId,
      })).patterns
    : [];
  const choice = choiceOf(move, selection, patterns);
  const here = yield* DeviceId.current;
  const sourceOf = {
    sourceDeviceId: move.deviceId,
    sourceProjectId: move.projectId,
    sourceWorktreeId: move.worktreeId,
  };
  if (move.kind === "mirror") {
    const copied = yield* startMirrorFrom(
      { ...sourceOf, ...choice },
      unattended,
    );
    return {
      landed: {
        deviceId: here,
        projectId: copied.worktree.projectId,
        worktreeId: copied.worktree.id,
      },
    } satisfies QueuedOutcome;
  }
  const pulled = yield* pullWorktree(
    {
      ...sourceOf,
      sourceIdentity: move.identity,
      branch: source.branch,
      worktreeName: pullWorktreeName(source),
      ...choice,
    },
    unattended,
  );
  return yield* settled(
    move,
    {
      deviceId: here,
      projectId: pulled.worktree.projectId,
      worktreeId: pulled.worktree.id,
    },
    pullSettle(move, unattended),
  );
});

export const runQueued = (move: SyncQueueMovePayload) => {
  const selection = selectionOfPreset(move.rule);
  return move.direction === "send"
    ? sendQueued(move, selection)
    : pullQueued(move, selection);
};
