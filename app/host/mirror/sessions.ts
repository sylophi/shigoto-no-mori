// The mirror sessions this device runs, the executor behind the mirror
// handlers (host/ipc/modules/mirror.ts): starting one, stopping it with
// its copy, pausing, re-opening it on a new rule, and the list. The
// daemon that owns the sessions (host/mirror/daemon.ts) arrives
// through the registry's slot.
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
// applyGitState), which is the grant the send already needed, or
// through the invitation the copy's device left when it asked
// (host/mirror/invites.ts), which admits exactly those calls. So a
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
  type MirrorIgnoreMode,
  type MirrorListResult,
  type MirrorSession,
  type MirrorStartFromPayload,
  type MirrorStartToPayload,
  MirrorStartToResultSchema,
  mirrorStopBlocker,
  mirrorStopRefusal,
  summarizeIgnores,
} from "@shigomori/contracts/modules/mirror";
import {
  SyncPullProgressSchema,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import { errorMessageOf } from "@shigomori/contracts/errors";
import {
  peerMirrorFor,
  peerClient,
  peerWorktree,
  peerWorktreesFor,
  thisDeviceId,
} from "@host/ipc/peerSync";
import { runMove } from "@host/lib/sync/moves";
import { rollBackSent, sendWorktree } from "@host/lib/sync/move";
import { inviteMirror, listMirrorInvites } from "./invites";
import { transferFilesOnce } from "./oneShot";
import {
  annotateMirrorSession,
  mirrorStartRefusal,
  reopenInput,
  startLabels,
} from "./plan";
import {
  endMirrorKeepingCopy,
  endMirrorsIntoGoneCopy,
  engine,
  engineOrNull,
  findSession,
  localWorktreeIdOf,
  MirrorError,
  type MirrorSessionRaw,
  mirrorSessions,
  ORIGINAL_GONE_DETAIL,
  requireRunningEngine,
  rootExists,
} from "./registry";
import { announceServingChange, listMirrorServing } from "./serving";
import { log } from "@shared/log";

const decodePullProgress = Schema.decodeOption(SyncPullProgressSchema);
const decodeMirrorStartToResult = Schema.decodeUnknownSync(
  MirrorStartToResultSchema,
);

type Daemon = ReturnType<typeof engine>;

// Ignore changes in flight, by session: two at once (both devices'
// pages) would each open a session on the pair.
const reopening = new Set<string>();

// The sessions a stop has ended whose copy is still being removed,
// as last listed. The engine drops a session at terminate, and the
// copy's delete follows for seconds. Listed through that, the pair
// keeps reading as one worktree (the sidebar folds it, the page keeps
// its pill) instead of the copy surfacing as a worktree of its own
// until it vanishes.
const stopping = new Map<string, MirrorSession>();

// The sessions as last listed by a running daemon. A daemon that is
// restarting (a crash, the restart ladder) reports none, and the same
// sessions come back with it: listed as nothing meanwhile, every pair
// would unfold, every pill and Mirror button vanish, an open dialog
// close and the start buttons come back, for as long as the restart
// takes. So the last list stands until the daemon runs again, under
// the daemon status that says why nothing moves.
let lastListed: MirrorSession[] = [];

// A device's mirror picture: what mirror:list answers and what
// mirror:changed carries. The same for every caller.
export const mirrorList = (daemon: Daemon = engine()) =>
  Effect.gen(function* () {
    const status = yield* daemon.status;
    const running = status === "running";
    const sessions = running
      ? (yield* mirrorSessions(daemon)).map((raw) =>
          annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
        )
      : [...lastListed];
    if (running) lastListed = [...sessions];
    const live = new Set(sessions.map((session) => session.session));
    for (const [id, session] of stopping) {
      if (!live.has(id)) sessions.push(session);
    }
    return {
      daemon: status,
      sessions,
      serving: listMirrorServing(),
    } satisfies MirrorListResult;
  });

// The list for the changed broadcast, or undefined, which a reader
// answers by asking. Before the daemon is wired there is none to send.
// A list that fails to build is said so.
export const currentMirrorList = Effect.suspend(() => {
  const daemon = engineOrNull();
  if (daemon === null) return Effect.succeed(undefined);
  return mirrorList(daemon).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        log.warn(
          `[mirror] the changed broadcast goes without its list: ${errorMessageOf(cause)}`,
        );
        return undefined;
      }),
    ),
  );
});

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
    const refusal = mirrorStartRefusal(input.worktreeId, {
      sessions: yield* mirrorSessions(daemon),
      servedWorktreeIds: listMirrorServing().map((stream) => stream.worktreeId),
      invitedCopyIds: listMirrorInvites().map(
        (invite) => invite.copy?.worktreeId,
      ),
    });
    if (refusal !== null) {
      return yield* new MirrorStartRefusedError({ reason: refusal });
    }
    const { ignoreMode, ignores, ...sendInput } = input;
    return yield* runMove(ctx, input.worktreeId, () =>
      Effect.gen(function* () {
        const { source, result: sent } = yield* sendWorktree(sendInput, ctx, {
          mirror: true,
        });
        // The copy's root as the peer's landing answered it, re-parsed
        // by the send.
        const copy = sent.worktree;
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
      }),
    );
  });

// The ask from the copy's side. The session runs on the peer, which
// holds the original: this device invites the mirror (invites.ts),
// then asks the peer's startTo towards here, and the peer's send,
// stream and git half land through that invitation whatever this
// device's switch says. The peer's progress comes back as its
// pushes, keyed by its worktree, and is relayed to the caller. The
// caller going away (a closed window or CLI socket aborts the
// context) cancels the start on the peer, the way the dialog's
// cancel does: the peer's send stops and the copy it made here goes.
// A start that fails withdraws the invitation: the peer's rollback
// already removed whatever landed under it.
export const startMirrorFrom = (
  input: MirrorStartFromPayload,
  ctx: HandlerContext,
) => {
  const {
    sourceDeviceId,
    sourceProjectId: projectId,
    sourceWorktreeId: worktreeId,
    sourceIdentity: identity,
    ...rule
  } = input;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const notify = ctx.notifier(syncContract, "pullProgress");
      return peerClient(syncContract, sourceDeviceId).onPullProgress(
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
    // A move like the others (runMove), so the dialog's and the
    // CLI's cancel (sync:cancelMove, by the source worktree) and a
    // caller going away both reach it, and interrupt the peer's send
    // over the device link. The invitation is made inside, once the
    // move holds its key: a second ask for the same worktree is refused
    // without touching the first's.
    () =>
      runMove(ctx, worktreeId, () =>
        Effect.gen(function* () {
          const invite = inviteMirror({
            peerDeviceId: sourceDeviceId,
            sourceWorktreeId: worktreeId,
            identity,
            cloneInto: rule.cloneInto,
          });
          const started = yield* peerMirrorFor(sourceDeviceId)
            .startTo({
              targetDeviceId: thisDeviceId(),
              projectId,
              worktreeId,
              ...rule,
            })
            .pipe(Effect.onError(() => Effect.sync(() => invite.withdraw())));
          return decodeMirrorStartToResult(started);
        }),
      ),
    (stopRelay) => Effect.sync(stopRelay),
  );
};

// Stop ends the session and removes the copy the mirror made: the
// mirror was the copy's reason to exist, and the source keeps the
// branch. The copy is the peer's worktree, and the original here
// stays. The delete follows the terminate (the other way round the
// tombstone protocol would stop the session itself, mid-delete) and
// is forced, since the copy carries the source's uncommitted state
// by design. A copy the delete cannot remove is reported with the
// session already gone: the worktree page then offers the ordinary
// delete.
//
// A stop whose original is gone (removed outside the app) ends the
// session alone: the copy is then the only one there is, and it is
// never removed, forced or not.
export const stopMirror = (session: string, force: boolean) =>
  Effect.gen(function* () {
    const daemon = engine();
    const raw = yield* findSession(daemon, session);
    if (raw === undefined) {
      return yield* new MirrorError({
        reason: "That mirror is no longer running.",
      });
    }
    if (!(yield* Effect.promise(() => rootExists(raw.localRoot)))) {
      yield* endMirrorKeepingCopy(daemon, raw, ORIGINAL_GONE_DETAIL);
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
        if (yield* endMirrorIfCopyGone(raw)) return { removedCopy: true };
        return yield* new MirrorError({ reason: mirrorStopRefusal(blocker) });
      }
    }
    stopping.set(session, {
      ...annotateMirrorSession(raw, daemon.gitStatus(session)),
      stopping: true,
    });
    yield* stopAndRemoveCopy(daemon, session, raw).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stopping.delete(session);
          announceServingChange();
        }),
      ),
    );
    return { removedCopy: true };
  });

// The stop past the safety check: the engine ends the session, then
// the copy on the peer goes. A copy that stayed is reported, with the
// session already gone. The original here keeps its page, so its
// thread gets the line either way.
const stopAndRemoveCopy = Effect.fnUntraced(function* (
  daemon: Daemon,
  session: string,
  raw: MirrorSessionRaw,
) {
  yield* daemon.terminate(session);
  const stayed = yield* peerWorktreesFor(raw.deviceId)
    .delete({
      projectId: raw.projectId,
      worktreeId: raw.worktreeId,
      force: true,
    })
    .pipe(
      Effect.map((removed) =>
        removed.ok ? null : `its ${removed.cleanupError.phase} step failed`,
      ),
      // A forced stop of a copy that was already gone has nothing left
      // to remove.
      Effect.catch((error) =>
        Effect.map(copyIsGone(raw), (gone) =>
          gone ? null : errorMessageOf(error),
        ),
      ),
    );
  daemon.noteEvent(
    localWorktreeIdOf(raw),
    "stopped",
    stayed === null ? "" : "Copy on the other device kept",
  );
  if (stayed !== null) {
    return yield* new MirrorError({
      reason: `${MIRROR_COPY_STAYED} on the other device stayed: ${stayed}. Delete it from its page.`,
    });
  }
});

// Whether the peer answers, within a few seconds, that it no longer
// lists the session's copy. A peer that fails or stalls is no answer.
// A folder deleted by hand still lists until git prunes it.
const COPY_PROBE_MS = 5_000;
const copyIsGone = (
  raw: Pick<MirrorSessionRaw, "deviceId" | "projectId" | "worktreeId">,
) =>
  peerWorktree(raw.deviceId, raw.projectId, raw.worktreeId).pipe(
    Effect.map((copy) => copy === undefined),
    Effect.timeoutOrElse({
      duration: COPY_PROBE_MS,
      orElse: () => Effect.succeed(false),
    }),
    Effect.orElseSucceed(() => false),
  );

// A copy the peer no longer lists (deleted while this device missed
// the announcement, or moved) ends its session: the stop's way out when
// the copy cannot be confirmed in step. True when it ended them.
export const endMirrorIfCopyGone = (session: {
  deviceId: string;
  projectId: string;
  worktreeId: string;
}) =>
  Effect.gen(function* () {
    if (!(yield* copyIsGone(session))) return false;
    yield* endMirrorsIntoGoneCopy(
      session.deviceId,
      session.projectId,
      session.worktreeId,
    );
    return true;
  });

// A resume against a peer that is away answers with the connect's
// error after the engine has already un-paused the session and started
// its loop, which keeps retrying: that is a resume, not a failure, and
// the page shows it reconnecting. A halted session resumes the same
// way, its loop started again.
export const pauseOrResume = (session: string, verb: "pause" | "resume") =>
  Effect.gen(function* () {
    const daemon = engine();
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
      localWorktreeIdOf(yield* findSession(daemon, session)),
      verb === "pause" ? "paused" : "resumed",
      "",
    );
  });

// The engine cannot re-configure a live session, so a change of
// ignores re-opens it on the same pair (MirrorImpl.recreate, which
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
    const daemon = engine();
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
    if (reopening.has(session)) {
      return yield* new MirrorError({
        reason: "What the mirror leaves out is already changing.",
      });
    }
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => reopening.add(session)),
      () =>
        Effect.gen(function* () {
          const next = yield* daemon.recreate(
            session,
            reopenInput(raw, ignoreMode, ignores),
          );
          daemon.noteEvent(
            localWorktreeIdOf(raw),
            "ignores-changed",
            summarizeIgnores(ignoreMode, ignores),
          );
          return { session: next };
        }),
      () => Effect.sync(() => reopening.delete(session)),
    );
  });
