// The mirror engine (MirrorEngine.ts) as the host runs it: the daemon's
// sessions with the git follower and the threads over them, and the
// bookkeeping each snapshot runs. Apart from the tag because the
// helpers it runs (registry.ts, sessions.ts) reach the engine by that
// tag.
import { errorMessageOf } from "@shigomori/contracts/errors";
import * as MirrorAgreements from "@shigomori/engine/MirrorAgreements";
import * as MirrorHistoryStore from "@shigomori/engine/MirrorHistory";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as WtFolder from "@shigomori/engine/WtFolder";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { errorWordsOf } from "@host/lib/errorWords";
import { PeerReach } from "@host/ipc/PeerReach";
import type { MirrorStatus } from "@shigomori/contracts/modules/mirror";
import * as HostAccount from "@host/lib/HostAccount";
import { makeGitFollower } from "./gitFollow";
import { createMirrorHistory } from "./history";
import * as MirrorDaemon from "./MirrorDaemon";
import {
  type MirrorCreateInput,
  MirrorEngine,
  MirrorError,
} from "./MirrorEngine";
import {
  endMirrorsWithPeers,
  isOrphanedTransfer,
  LEFT_ACCOUNT_DETAIL,
  mirrorSessions,
  settleMirrorBookkeeping,
  whileRecreating,
} from "./registry";
import { endMirrorIfCopyGone } from "./sessions";

// A device leaving its account ends its mirrors within this, so a stuck
// daemon request cannot hold the sign-out: the hub refresh that follows
// closes the sessions the sweep's terminates ride.
const LEAVE_ACCOUNT_LIMIT = "5 seconds";

// A session waiting on its link. A halt waits on a person instead, and
// a resume would clear it.
const LINK_LOST: ReadonlySet<MirrorStatus> = new Set([
  "disconnected",
  "connecting-local",
  "connecting-remote",
]);

type Bookkeeping = Exclude<
  | PeerReach
  | Effect.Services<typeof settleMirrorBookkeeping>
  | Effect.Services<ReturnType<typeof endMirrorsWithPeers>>
  | Effect.Services<ReturnType<typeof endMirrorIfCopyGone>>,
  MirrorEngine
>;

const make = (options: {
  // Anything a window shows of the mirrors moved: a follower's verdict
  // or a thread's event.
  readonly onChange: () => void;
  // A pull the follower applied moved a project's git state here.
  readonly projectChanged: (projectId: string) => void;
}) =>
  Effect.gen(function* () {
    const daemon = yield* MirrorDaemon.MirrorDaemon;
    const account = yield* HostAccount.HostAccount;
    const reach = yield* PeerReach;
    const runFork = yield* FiberSet.makeRuntime<never>();
    const context = yield* Effect.context<Bookkeeping>();
    // What reaches the engine through its tag, run on this one.
    const withEngine = <A, E>(
      effect: Effect.Effect<A, E, Bookkeeping | MirrorEngine>,
    ) =>
      Effect.suspend(() =>
        effect.pipe(
          Effect.provideService(MirrorEngine, engine),
          Effect.provideContext(context),
        ),
      );

    // Every thread as the store had it, written back a turn after it
    // changes, one write at a time.
    const threads = yield* MirrorHistoryStore.MirrorHistory;
    const saved = yield* threads.load;
    const writes = yield* Semaphore.make(1);
    const history = createMirrorHistory({
      store: {
        load: () => ({ ...saved }),
        save: (events) => {
          runFork(writes.withPermit(threads.save(events)));
        },
      },
      onChange: options.onChange,
    });

    // Every re-key the engine records (WtFolder.movedIds), this process's
    // or another's (the terminal's adopt or relocate), carries the thread
    // kept under the old id: those made while the app was closed as it
    // comes up, and each one after as the store records it. The sessions
    // follow at the daemon's next snapshot, which finds their root gone
    // and the move recorded (settleMirrorBookkeeping).
    const folder = yield* WtFolder.WtFolder;
    const carried = new Map<string, string>();
    const carryRekeys = Effect.gen(function* () {
      for (const [from, to] of yield* folder.movedIds) {
        if (carried.get(from) === to) continue;
        carried.set(from, to);
        history.move(from, to);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("[mirror] a worktree's re-key went unread", cause),
      ),
    );
    const stored = yield* (yield* StoreChanges.StoreChanges).subscribe;
    yield* carryRekeys.pipe(
      Effect.andThen(
        stored.pipe(
          Stream.filter((tables) => tables.has("wt_moves")),
          Stream.runForEach(() => carryRekeys),
        ),
      ),
      Effect.forkScoped,
    );

    const follower = yield* makeGitFollower({
      sessions: mirrorSessions(daemon),
      fresh: daemon.fresh,
      followDescription: true,
      // The states both sides last agreed on, in the store so a restart
      // resumes the follow rule rather than falling back to ancestry.
      agreedStore: yield* MirrorAgreements.MirrorAgreements,
      onChange: () => {
        options.onChange();
        runFork(observeHistory);
      },
      // The peer says the session's copy is gone, behind this device's
      // back: confirmed against the peer's own list (an answer while its
      // registry loads, or mid-move, is no removal), the session ends and
      // the original keeps its own.
      onCopyGone: (session) =>
        runFork(Effect.ignore(withEngine(endMirrorIfCopyGone(session)))),
      // Announced at once, so the pages showing it refetch without
      // waiting on the git watcher.
      onLocalApplied: (projectId) => {
        options.projectChanged(projectId);
        follower.onLocalProjectChanged(projectId);
      },
    });

    // The daemon's sessions that are mirrors, into their threads, off its
    // own snapshots: the one that stands through a restart moves nothing,
    // and the sessions the next run brings back are seen afresh.
    let restarted = false;
    const observeHistory = Effect.gen(function* () {
      if (!(yield* daemon.fresh)) {
        restarted = true;
        return;
      }
      if (restarted) {
        restarted = false;
        history.restarted();
      }
      history.observe(yield* mirrorSessions(daemon), (session) =>
        follower.statusOf(session),
      );
    });

    const fromDaemon = Effect.mapError(
      (error: MirrorDaemon.MirrorDaemonError) =>
        new MirrorError({ reason: error.message }),
    );

    const create = Effect.fn("MirrorEngine.create")(function* (
      input: MirrorCreateInput,
    ) {
      // A start's long leg (the copy across) can straddle a sign-out;
      // the sweep that ran meanwhile found nothing, so this is the last
      // gate before a session with a peer of no account.
      if ((yield* account.current).facts === null) {
        return yield* new MirrorError({
          reason: "This device is signed out, so it cannot mirror.",
        });
      }
      return yield* fromDaemon(daemon.create(input));
    });

    // The old session is paused, not ended, until the new one is up: two
    // running sessions on one root would fight, but a paused one holds
    // nothing, and a create that fails (peer away) then leaves the
    // mirror as it was instead of gone with no way to re-open it. The
    // agreement moves to the new id, so the follower picks up where it
    // was instead of starting from the no-agreement fallback. Held as
    // recreating throughout, so the leftover sweep (registry.ts
    // settleMirrorBookkeeping) does not end the old session under it.
    const recreate = Effect.fn("MirrorEngine.recreate")(
      (session: string, input: MirrorCreateInput) =>
        whileRecreating(
          session,
          Effect.gen(function* () {
            // Undone however the create ends short of a session, an
            // interrupt included.
            const next = yield* Effect.acquireUseRelease(
              fromDaemon(daemon.pause(session)),
              () => create(input),
              (_, exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.ignoreCause(daemon.resume(session), {
                      log: "Warn",
                      message: "[mirror] the paused session didn't resume",
                    }),
            );
            // An old session already gone by now was ended all the same.
            yield* fromDaemon(daemon.terminate(session)).pipe(
              Effect.catch((error) =>
                Effect.flatMap(daemon.sessions, (sessions) =>
                  sessions.some((raw) => raw.session === session)
                    ? Effect.fail(error)
                    : Effect.void,
                ),
              ),
            );
            follower.rename(session, next);
            return next;
          }),
        ),
    );

    // An explicit stop ends the agreement too, or the git follower's
    // store keeps one entry per session ever created. A terminate that
    // failed still ends it: the session is doomed either way, and the
    // entry would otherwise outlive the daemon that could ever match it.
    const terminate = Effect.fn("MirrorEngine.terminate")((session: string) =>
      fromDaemon(daemon.terminate(session)).pipe(
        Effect.asVoid,
        Effect.ensuring(Effect.sync(() => follower.forget(session))),
      ),
    );

    // A transfer session no pull here is waiting on (registry.ts
    // isOrphanedTransfer) is ended on sight, since no mirror surface
    // would ever show it, off the running daemon's own snapshot. Each is
    // asked once while its end is under way or done, and the engine drops
    // it from the next snapshot; one whose end failed is asked again.
    const reaped = new Set<string>();
    const reapOrphanedTransfers = Effect.gen(function* () {
      if (!(yield* daemon.fresh)) return;
      yield* Effect.forEach(
        (yield* daemon.sessions).filter(
          (session) =>
            isOrphanedTransfer(session) && !reaped.has(session.session),
        ),
        (session) => {
          reaped.add(session.session);
          return terminate(session.session).pipe(
            Effect.catch((error) =>
              Effect.sync(() => reaped.delete(session.session)).pipe(
                Effect.andThen(
                  Effect.logWarning(
                    `[mirror] could not end an orphaned transfer session: ${error.message}`,
                  ),
                ),
              ),
            ),
          );
        },
        { discard: true },
      );
    });

    const engine = MirrorEngine.of({
      status: daemon.status,
      failure: daemon.failure,
      sessions: daemon.sessions,
      fresh: daemon.fresh,
      create,
      recreate,
      terminate,
      pause: Effect.fn("MirrorEngine.pause")((session: string) =>
        Effect.asVoid(fromDaemon(daemon.pause(session))),
      ),
      resume: Effect.fn("MirrorEngine.resume")((session: string) =>
        Effect.asVoid(fromDaemon(daemon.resume(session))),
      ),
      gitStatus: (session) => follower.statusOf(session),
      refreshGit: Effect.fn("MirrorEngine.refreshGit")((session: string) =>
        follower.reconcileNow(session),
      ),
      history: (localWorktreeId) => history.eventsFor(localWorktreeId),
      noteEvent: (localWorktreeId, kind, detail) =>
        history.note(localWorktreeId, kind, detail),
      forgetHistory: (localWorktreeId) => history.forget(localWorktreeId),
      moveHistory: (from, to) => history.move(from, to),
      localProjectChanged: (projectId) =>
        follower.onLocalProjectChanged(projectId),
      peerProjectChanged: (deviceId, projectId) =>
        follower.onPeerProjectChanged(deviceId, projectId),
      peerWorktreeChanged: (deviceId, projectId, worktreeId) =>
        follower.onPeerWorktreeChanged(deviceId, projectId, worktreeId),
      leaveAccount: withEngine(
        endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
          transfers: true,
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: LEAVE_ACCOUNT_LIMIT,
          orElse: () => Effect.void,
        }),
        Effect.withSpan("MirrorEngine.leaveAccount"),
      ),
    });

    // A peer coming to take this device's calls (its link up, both of
    // its switches on): the sessions into it that wait on the link and
    // that nobody paused reconnect at once, not at the engine's next
    // retry, and git looks again.
    yield* reach.admissions.pipe(
      Stream.runForEach((deviceId) =>
        Effect.gen(function* () {
          for (const raw of yield* daemon.sessions) {
            if (
              raw.deviceId !== deviceId ||
              raw.paused ||
              !LINK_LOST.has(raw.status)
            ) {
              continue;
            }
            yield* Effect.ignoreCause(daemon.resume(raw.session), {
              log: "Warn",
              message: "[mirror] a session didn't reconnect",
            });
          }
          follower.onPeerAdmitted(deviceId);
        }),
      ),
      Effect.forkScoped,
    );

    // Every snapshot: the follower compares the session set itself (one
    // that only moved a cycle count is a no-op there), and the history,
    // the orphaned transfers, and the stops that waited for the daemon,
    // originals gone behind the app's back, sessions a re-open replaced
    // (registry.ts) are looked at again.
    yield* daemon.changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          follower.sessionsChanged();
          runFork(
            Effect.ignore(
              Effect.all([
                observeHistory,
                reapOrphanedTransfers,
                withEngine(settleMirrorBookkeeping),
              ]),
            ),
          );
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning(
              `[mirror] a daemon change went unread: ${errorWordsOf(defect)}`,
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    return engine;
  });

// An engine that failed to start (its stores unreadable) answers as
// unavailable and refuses every change, saying why, and the rest of the
// app comes up without mirrors.
const unavailable = (cause: Cause.Cause<unknown>) => {
  const refused = new MirrorError({
    reason: `The mirror engine failed to start: ${errorMessageOf(Cause.squash(cause))}.`,
  });
  return MirrorEngine.of({
    status: Effect.succeed("unavailable"),
    failure: Effect.succeed(undefined),
    sessions: Effect.succeed([]),
    fresh: Effect.succeed(false),
    create: () => Effect.fail(refused),
    recreate: () => Effect.fail(refused),
    terminate: () => Effect.fail(refused),
    pause: () => Effect.fail(refused),
    resume: () => Effect.fail(refused),
    gitStatus: () => undefined,
    refreshGit: () => Effect.succeed(undefined),
    history: () => [],
    noteEvent: () => {},
    forgetHistory: () => {},
    moveHistory: () => {},
    localProjectChanged: () => {},
    peerProjectChanged: () => {},
    peerWorktreeChanged: () => {},
    leaveAccount: Effect.void,
  });
};

export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(
    MirrorEngine,
    make(options).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(
          "[boot] the mirror engine failed to start:",
          cause,
        ).pipe(Effect.as(unavailable(cause))),
      ),
    ),
  );
