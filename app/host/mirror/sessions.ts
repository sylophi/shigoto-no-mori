// The mirror sessions this device runs, the executor behind the mirror
// handlers (host/ipc/modules/mirror.ts): starting one, stopping it with
// its copy, pausing, and re-opening it on a new rule, over the mirror
// engine (MirrorEngine.ts) and what the ledger keeps (MirrorLedger.ts).
//
// start = send, then mirror. The send (sync's, reused verbatim) lands
// the worktree's branch, commits and uncommitted changes on the peer
// as a new worktree through the ordinary create, so carry-over (and
// setup, when the dialog asked for it) ride along and git agrees on
// both sides before a single file is watched. The mirror session then
// opens between the two worktrees, with almost nothing left to move.
// The session always runs HERE, on the device holding the original,
// whichever device asked for it (the copy's device asks over the
// grant, startFrom below): it reaches the copy's `file-sync serve`
// and git state through the peer's grant (openStream, gitState,
// applyGitState), which is the grant the send already needed. So a
// stop always removes the peer's worktree. The copy's root path is
// read off the peer's own landing answer over the grant-gated wire,
// never taken from the caller.
//
// A primary checkout is mirrored the same way, its copy on
// mirror/<branch> in a mirror-<name> folder (contracts' git/branches.ts),
// and the session's mode says so, so the git follower reads the two
// branch names as one. Both primaries keep what they had.
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  MIRROR_COPY_STAYED,
  mirrorFilesSettled,
  type MirrorStartFromPayload,
  type MirrorStartToPayload,
  MirrorStartToResultSchema,
  mirrorStopBlocker,
  mirrorStopRefusal,
  summarizeIgnores,
} from "@shigomori/contracts/modules/mirror";
import {
  type MirrorIgnoreMode,
  SyncPullProgressSchema,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import { PeerReach, peerMirrorFor } from "@host/ipc/PeerReach";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as Moves from "@host/lib/sync/Moves";
import { rollBackSent, sendWorktree } from "@host/lib/sync/move";
import { transferFilesOnce } from "./oneShot";
import {
  annotateMirrorSession,
  mirrorStartRefusal,
  reopenInput,
  startLabels,
} from "./plan";
import {
  findSession,
  type MirrorSessionRaw,
  mirrorSessions,
  ORIGINAL_GONE_DETAIL,
  requireRunningEngine,
  rootExists,
  STOPPED_WAITING_DETAIL,
} from "./registry";
import { MirrorEngine, MirrorError } from "./MirrorEngine";
import { MirrorLedger } from "./MirrorLedger";
import { ownMirrorHereBlocker } from "./MirrorGateway";

const decodePullProgress = Schema.decodeUnknownOption(SyncPullProgressSchema);
const decodeMirrorStartToResult = Schema.decodeUnknownSync(
  MirrorStartToResultSchema,
);

type Daemon = MirrorEngine["Service"];

// The mirror: one of this device's worktrees, sent to a peer and kept
// in step with the copy made there. No leave-out rule goes to the
// send: the session opened next carries the ignored files and keeps
// carrying them. No session, so no copy either: the peer's copy is
// removed (the original still holds the branch and its uncommitted
// changes), or a retry would refuse on the branch the failed attempt
// left behind. That removal is best effort: its own failure is
// logged, not thrown over the real error. A cancel (sync:cancelMove,
// by the worktree, from the caller: the copy's device when it asked
// for the mirror) is the send's cancel while the send runs, and
// past it the same rollback as a failed session open, the session
// ended if the open outran the cancel.
class MirrorStartRefusedError extends Schema.TaggedError<MirrorStartRefusedError>()(
  "MirrorStartRefusedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const startMirrorTo = (
  input: MirrorStartToPayload,
  ctx: HandlerContext,
) =>
  Effect.gen(function* () {
    const daemon = yield* requireRunningEngine;
    const ledger = yield* MirrorLedger;
    const refusal = mirrorStartRefusal(input.worktreeId, {
      sessions: yield* mirrorSessions(daemon),
      servedWorktreeIds: ledger
        .listServing()
        .map((stream) => stream.worktreeId),
    });
    if (refusal !== null) {
      return yield* new MirrorStartRefusedError({ reason: refusal });
    }
    const { ignoreMode, ignores, ...sendInput } = input;
    const moves = yield* Moves.Moves;
    const noteCopy = (worktreeId: string) =>
      ledger.noteStarting({
        localWorktreeId: input.worktreeId,
        deviceId: input.targetDeviceId,
        worktreeId,
      });
    return yield* moves.run(
      ctx,
      input.worktreeId,
      Effect.gen(function* () {
        const { source, result: sent } = yield* sendWorktree(sendInput, ctx, {
          mirror: true,
          onCopy: noteCopy,
        });
        // The copy's root as the peer's landing answered it, re-parsed
        // by the send.
        const copy = sent.worktree;
        noteCopy(copy.id);
        const session = yield* Effect.gen(function* () {
          // The copy's create ran its carry-over (and the setup script,
          // when asked), which wrote files of the peer's own into it.
          // Opened on that, the two-way session would hold every such
          // path the rule does not leave out as a conflict from its first
          // cycle (or carry a file only the copy has back here). So the
          // copy is made an exact copy of the original first, the rule's
          // paths left alone, and the session opens on two identical
          // trees.
          const replica = yield* transferFilesOnce(
            {
              localRoot: source.path,
              localWorktreeId: source.id,
              sourceDeviceId: input.targetDeviceId,
              sourceProjectId: copy.projectId,
              sourceWorktreeId: copy.id,
              remoteRoot: copy.path,
              name: source.branch,
              ignores,
              direction: "replica",
            },
            () => {},
          );
          if (!replica.crossed) {
            return yield* new MirrorError({
              reason: `The files could not be brought in step: ${replica.error ?? "unknown error"}`,
            });
          }
          // A session the open made is ended again if the start was
          // cancelled before it was in.
          return yield* Effect.acquireRelease(
            Effect.uninterruptible(
              daemon.create({
                localRoot: source.path,
                deviceId: input.targetDeviceId,
                projectId: copy.projectId,
                worktreeId: copy.id,
                remoteRoot: copy.path,
                name: source.branch,
                localWorktreeId: source.id,
                labels: startLabels(source, ignoreMode),
                ignores,
              }),
            ),
            (made, exit) =>
              Exit.hasInterrupts(exit)
                ? Effect.ignore(daemon.terminate(made))
                : Effect.void,
          );
        }).pipe(
          Effect.scoped,
          Effect.onError(() => rollBackSent(input.targetDeviceId, copy)),
        );
        daemon.noteEvent(
          source.id,
          "started",
          summarizeIgnores(ignoreMode, ignores),
        );
        return { ...sent, session };
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => ledger.forgetStarting(input.worktreeId)),
        ),
      ),
    );
  });

// The ask from the copy's side. The session runs on the peer, which
// holds the original: this device asks the peer's startTo towards
// here, and the peer's send, stream and git half land through this
// device's own switches, so a switch that is off refuses the ask
// before the peer hears of it. The peer's progress comes back as its
// pushes, keyed by its worktree, and is relayed to the caller. The
// caller going away (a closed window or CLI socket aborts the
// context) cancels the start on the peer, the way the dialog's
// cancel does: the peer's send stops and the copy it made here goes.
export const startMirrorFrom = (
  input: MirrorStartFromPayload,
  ctx: HandlerContext,
) => {
  const {
    sourceDeviceId,
    sourceProjectId: projectId,
    sourceWorktreeId: worktreeId,
    ...rule
  } = input;
  const ask = Effect.acquireUseRelease(
    Effect.map(PeerReach, (reach) => {
      const notify = ctx.notifier(syncContract, "pullProgress");
      return reach.onPush(
        syncContract,
        "pullProgress",
        sourceDeviceId,
        (frame) => {
          const parsed = decodePullProgress(frame);
          if (
            Option.isSome(parsed) &&
            parsed.value.sourceWorktreeId === worktreeId
          ) {
            notify(parsed.value);
          }
        },
      );
    }),
    // A move like the others (Moves.ts), so the dialog's and the
    // CLI's cancel (sync:cancelMove, by the source worktree) and a
    // caller going away both reach it, and interrupt the peer's send
    // over the device link.
    () =>
      Effect.flatMap(Moves.Moves, (moves) =>
        moves.run(
          ctx,
          worktreeId,
          Effect.gen(function* () {
            const started = yield* peerMirrorFor(sourceDeviceId).startTo({
              targetDeviceId: yield* DeviceId.current,
              projectId,
              worktreeId,
              ...rule,
            });
            return decodeMirrorStartToResult(started);
          }),
        ),
      ),
    (stopRelay) => Effect.sync(stopRelay),
  );
  return Effect.gen(function* () {
    const blocker = yield* ownMirrorHereBlocker;
    if (blocker !== undefined) {
      return yield* new MirrorStartRefusedError({ reason: blocker });
    }
    return yield* ask;
  });
};

// Stop ends the session and removes the copy the mirror made: the
// mirror was the copy's reason to exist, and the source keeps the
// branch. The copy is the peer's worktree, and the original here
// stays. The delete follows the terminate (ledger/ends.ts says why). A
// copy the delete cannot remove is reported with the session already
// gone: the worktree page then offers the ordinary delete.
//
// A stop whose original is gone (removed outside the app) ends the
// session alone: the copy is then the only one there is, and it is
// never removed, forced or not.
export const stopMirror = (session: string, force: boolean) =>
  Effect.gen(function* () {
    const daemon = yield* MirrorEngine;
    const ledger = yield* MirrorLedger;
    const raw = yield* findSession(daemon, session);
    if (raw === undefined) {
      return yield* new MirrorError({
        reason: "That mirror is no longer running.",
      });
    }
    if (!(yield* Effect.promise(() => rootExists(raw.localRoot)))) {
      // A moved original's, waiting on its peer, isn't gone.
      yield* ledger.endMirrorKeepingCopy(
        daemon,
        raw,
        ledger.isWaitingOnPeer(session)
          ? STOPPED_WAITING_DETAIL
          : ORIGINAL_GONE_DETAIL,
      );
      return { removedCopy: false };
    }
    // The copy goes with the stop, so it must hold nothing the original
    // lacks: git in step, looked at again now rather than read off the
    // last verdict (a commit on the copy a moment ago is exactly what
    // must not be lost), and the files settled, since git says nothing
    // about an edit the engine has not carried yet or holds still as a
    // conflict.
    if (!force) {
      const git = yield* daemon.refreshGit(session);
      const live = (yield* findSession(daemon, session)) ?? raw;
      const blocker = mirrorStopBlocker({ ...live, git });
      if (blocker !== undefined) {
        // A copy the peer no longer lists (deleted while this device
        // missed the announcement, or moved) holds nothing to protect
        // and nothing to remove, so the session just ends.
        if (yield* ledger.endMirrorIfCopyGone(raw)) {
          return { removedCopy: true };
        }
        return yield* new MirrorError({ reason: mirrorStopRefusal(blocker) });
      }
    }
    yield* ledger.whileStopping(
      session,
      {
        ...annotateMirrorSession(raw, daemon.gitStatus(session)),
        stopping: true,
      },
      stopAndRemoveCopy(daemon, ledger, raw),
    );
    return { removedCopy: true };
  });

// The stop past the safety check: the engine ends the session, then
// the copy on the peer goes. A copy that stayed is reported, with the
// session already gone. The original here keeps its page, so its
// thread gets the line either way.
const stopAndRemoveCopy = Effect.fnUntraced(function* (
  daemon: Daemon,
  ledger: MirrorLedger["Service"],
  raw: MirrorSessionRaw,
) {
  const stayed = yield* ledger.endThenDeleteCopy(daemon, raw);
  daemon.noteEvent(
    raw.localWorktreeId,
    "stopped",
    stayed === undefined ? "" : "Copy on the other device kept",
  );
  if (stayed !== undefined) {
    return yield* new MirrorError({
      reason: `${MIRROR_COPY_STAYED} on the other device stayed: ${stayed}. Delete it from its page.`,
    });
  }
});

// A resume against a peer that is away answers with the connect's
// error after the engine has already un-paused the session and started
// its loop, which keeps retrying: that is a resume, not a failure, and
// the page shows it reconnecting. A halted session resumes the same
// way, its loop started again.
export const pauseOrResume = (session: string, verb: "pause" | "resume") =>
  Effect.gen(function* () {
    const daemon = yield* MirrorEngine;
    yield* daemon[verb](session).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const after = yield* findSession(daemon, session);
          if (verb !== "resume" || after === undefined || after.paused) {
            return yield* error;
          }
        }),
      ),
    );
    daemon.noteEvent(
      (yield* findSession(daemon, session))?.localWorktreeId ?? "",
      verb === "pause" ? "paused" : "resumed",
      "",
    );
  });

// The engine cannot re-configure a live session, so a change of
// ignores re-opens it on the same pair (MirrorEngine's recreate, which
// keeps the old one until the new one is up and carries the git
// follower's agreement across), the labels carried over. The pair's
// files are already in agreement, so the new session's first cycle
// has little to do.
//
// Only on a settled pair: the new session starts with no shared
// history, so a path only one side holds crosses to the other. On a
// pair in step that is nothing. On a paused, halted or conflicted
// one it would bring back what was deleted on one side meanwhile,
// and a paused session would come back running.
export const reopenMirror = (
  session: string,
  ignoreMode: MirrorIgnoreMode,
  ignores: readonly string[],
) =>
  Effect.gen(function* () {
    const daemon = yield* MirrorEngine;
    const ledger = yield* MirrorLedger;
    const raw = yield* findSession(daemon, session);
    if (raw === undefined) {
      return yield* new MirrorError({
        reason: "That mirror is no longer running.",
      });
    }
    if (!mirrorFilesSettled(raw)) {
      return yield* new MirrorError({
        reason:
          "What the mirror leaves out can change once it is running and in step. Resume it, or wait for it to catch up.",
      });
    }
    if (ledger.isRecreating(session)) {
      return yield* new MirrorError({
        reason: "This mirror is already re-opening. Try again in a moment.",
      });
    }
    const next = yield* daemon.recreate(
      session,
      reopenInput(raw, ignoreMode, ignores),
    );
    daemon.noteEvent(
      raw.localWorktreeId,
      "ignores-changed",
      summarizeIgnores(ignoreMode, ignores),
    );
    return { session: next };
  });
