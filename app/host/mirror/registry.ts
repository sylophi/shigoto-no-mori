// The vocabulary around the mirror daemon (MirrorEngine.ts): the labels
// the start orchestration writes on a session, the raw shapes the daemon
// reports, and the sweeps over its sessions. Separate from the mirror
// handler module so the worktree tombstone protocol
// (host/lib/scripts/removing.ts) can stop a worktree's
// mirrors without importing that module (which reaches sync, which
// reaches worktrees).
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { unmountedVolume } from "@shared/unmountedVolume";
import {
  MIRROR_LABEL_MODE,
  MIRROR_LABEL_REPLACES,
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
  type MirrorSessionRaw,
  mirrorEngineBlocker,
} from "@shigomori/contracts/modules/mirror";
import { errorWordsOf } from "@host/lib/errorWords";
import { ageOf, stamp, type Stamp } from "@host/lib/util/kept";
import { WorktreeRemovalSchema } from "@shigomori/contracts/schemas/worktree";
import { PeerReach } from "@host/ipc/PeerReach";
import { MirrorEngine, MirrorError } from "@host/mirror/MirrorEngine";
import { log } from "@shared/log";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Ops from "@host/lib/engineOps";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own. Ids only: the
// engine refuses label values outside its alphabet, and the branch is
// the local worktree's to report.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";

// The ignore rule the session was opened with (a MirrorIgnoreMode),
// so the page can say which rule its patterns came from. Absent on a
// session that predates it, which read as "everything".
export const MIRROR_LABEL_IGNORE_MODE = "ignoreMode";

// What kind of session it is (MIRROR_LABEL_MODE), or null for a mode
// this build does not know. A v2 session's labels are rewritten into a
// mode when the daemon loads it (file-sync/engine.go relabelV2Sessions).
type MirrorMode = "mirror" | "mirror-branch" | `transfer-${string}`;

const TRANSFER_PREFIX = "transfer-";

function modeOf(labels: Record<string, string>): MirrorMode | null {
  const mode = labels[MIRROR_LABEL_MODE];
  return mode === "mirror" ||
    mode === "mirror-branch" ||
    mode?.startsWith(TRANSFER_PREFIX) === true
    ? (mode as MirrorMode)
    : null;
}

export const transferModeFor = (token: string): MirrorMode =>
  `${TRANSFER_PREFIX}${token}`;

// The transfer's token, or null for a session that is not a transfer.
function transferTokenOf(labels: Record<string, string>): string | null {
  const mode = modeOf(labels);
  return mode?.startsWith(TRANSFER_PREFIX) === true
    ? mode.slice(TRANSFER_PREFIX.length)
    : null;
}

export const isTransferSession = (session: {
  labels: Record<string, string>;
}): boolean => transferTokenOf(session.labels) !== null;

export const onMirrorBranch = (session: {
  labels: Record<string, string>;
}): boolean => modeOf(session.labels) === "mirror-branch";

// The labels of the session that replaces `raw` on the same pair (a
// re-open, a moved worktree): its own carried over, and the session it
// replaces.
export function carriedLabels(
  raw: MirrorSessionRaw,
  changes: Record<string, string>,
): Record<string, string> {
  return {
    ...raw.labels,
    [MIRROR_LABEL_REPLACES]: raw.session,
    ...changes,
  };
}

// What the daemon reports for one session, before annotation
// (contracts' modules/mirror.ts), re-exported for the host's own callers.
export type { MirrorSessionRaw };

// The local worktree a session runs on, "" when its create named none.
export function localWorktreeIdOf(raw: MirrorSessionRaw | undefined): string {
  return raw?.localWorktreeId ?? "";
}

// The ignore mode a session's labels carry, "everything" when none.
const isMirrorIgnoreMode = Schema.is(MirrorIgnoreModeSchema);
export function ignoreModeOf(labels: Record<string, string>): MirrorIgnoreMode {
  const mode = labels[MIRROR_LABEL_IGNORE_MODE];
  return isMirrorIgnoreMode(mode) ? mode : "everything";
}

// The engine when it can take a session, or the reason it cannot:
// the mirror start and the transplant's file transfer both begin here.
export const requireRunningEngine = Effect.flatMap(MirrorEngine, (daemon) =>
  Effect.flatMap(
    Effect.all([daemon.status, daemon.failure]),
    ([status, failure]) => {
      const blocker = mirrorEngineBlocker(status, undefined, failure);
      return blocker === undefined
        ? Effect.succeed(daemon)
        : Effect.fail(new MirrorError({ reason: blocker }));
    },
  ),
);

// The daemon, or null where none is provided, for a caller that has a
// sensible answer without one.
export const engineOrNull = Effect.map(
  Effect.serviceOption(MirrorEngine),
  Option.getOrNull,
);

// The daemon's sessions that ARE mirrors: a transplant's one-shot
// transfer (host/mirror/oneShot.ts) rides the same daemon under a
// label, and nothing that lists, follows or narrates mirrors should
// see it. The transfer finds its own session on the raw list. Nor a
// session in a mode this build does not know.
export const mirrorSessions = (
  daemon: Pick<MirrorEngine["Service"], "sessions">,
) =>
  Effect.map(daemon.sessions, (sessions) =>
    sessions.filter((raw) => {
      const mode = modeOf(raw.labels);
      return mode === "mirror" || mode === "mirror-branch";
    }),
  );

// Which transfer a session is, written into its mode
// ("transfer-<token>"): one token per transfer, live from before its
// create is sent until its pull has ended it. A transfer session whose
// token is not live here has nobody waiting on it, and the host ends it
// on sight, since no mirror surface would ever show it. That covers
// every way one gets left behind: a quit or a crash mid-transfer (the
// engine persists its sessions, and the next launch knows none of their
// tokens), a create that was rejected after the engine had made the
// session, and a terminate that failed. It never covers a transfer
// still running, even on the snapshot that names the session before the
// create's own reply lands, because the token is live first.
// Each by the peer's worktree it runs against, which the gateway tells
// the peer (transferInto).
const liveTransfers = new Map<string, TransferTarget>();

export type TransferTarget = {
  readonly deviceId: string;
  readonly worktreeId: string;
  // Whether the files go into the peer's worktree or come out of it.
  readonly transfer: "in" | "out";
};

export function beginTransfer(target: TransferTarget): string {
  const token = randomUUID();
  liveTransfers.set(token, target);
  return token;
}

// How a transfer running here meets the peer's worktree, or undefined
// when none does (a live mirror's stream).
export function transferInto(
  deviceId: string,
  worktreeId: string,
): "in" | "out" | undefined {
  for (const target of liveTransfers.values()) {
    if (target.deviceId === deviceId && target.worktreeId === worktreeId) {
      return target.transfer;
    }
  }
  return undefined;
}

export function endTransfer(token: string): void {
  liveTransfers.delete(token);
}

export function isOrphanedTransfer(raw: MirrorSessionRaw): boolean {
  const token = transferTokenOf(raw.labels);
  return token !== null && !liveTransfers.has(token);
}

export const findSession = (daemon: MirrorEngine["Service"], session: string) =>
  Effect.map(daemon.sessions, (sessions) =>
    sessions.find((raw) => raw.session === session),
  );

// Every session whose local side is the named worktree, stopped. The
// tombstone protocol calls this once a delete or a relocate has gone
// through (withDeleteInflight says why after and not before): left
// alone, the session sits halted on a root that is gone or moved and
// the peer keeps calling its worktree mirrored. It goes through the
// injected impl, the one mirror:stop uses, so the git follower forgets
// the session too. A relocate changes the worktree id (it is path
// derived), but the label still carries the old one, which is what
// the caller passes.
//
// A session that refuses to stop is logged, not thrown: the delete is
// what was asked for, and a stuck mirror must not be what blocks it.
//
// A daemon that is not running (restarting, or still starting at
// boot) ends nothing, so the id waits in `pendingStops` and the first
// snapshot of a running daemon ends what it names
// (settleMirrorBookkeeping). The copy a peer holds stays a worktree of
// its own.
const pendingStops = new Set<string>();

export const stopMirrorsForWorktree = (localWorktreeId: string) =>
  Effect.gen(function* () {
    // Absent (a check that never mounts the daemon) there is nothing
    // mirroring anything.
    const daemon = yield* engineOrNull;
    if (daemon === null) return;
    if ((yield* daemon.status) === "running") {
      yield* endSessionsOnWorktree(daemon, localWorktreeId);
    } else {
      pendingStops.add(localWorktreeId);
    }
    // The worktree is gone, so its thread has no page left to show on.
    daemon.forgetHistory(localWorktreeId);
  });

const endSessionsOnWorktree = (
  daemon: MirrorEngine["Service"],
  localWorktreeId: string,
) =>
  Effect.flatMap(daemon.sessions, (sessions) =>
    Effect.forEach(
      sessions.filter((raw) => worktreeIdNow(raw) === localWorktreeId),
      (raw) =>
        daemon.terminate(raw.session).pipe(
          // A waiting session's old id has no worktree of its own: what
          // was noted there since the move goes too, so a worktree
          // made at the old folder doesn't inherit it.
          Effect.tap(() =>
            Effect.sync(() => {
              const labelled = localWorktreeIdOf(raw);
              if (labelled !== localWorktreeId) {
                daemon.forgetHistory(labelled);
              }
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              log.warn(
                `[mirror] could not stop the mirror of a worktree being deleted: ${errorWordsOf(error)}`,
              ),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    ),
  );

// A session's end, noted on the original's thread. A moved original's
// is the worktree it became (worktreeIdNow, read before the terminate:
// the daemon's snapshot without the session can come before its
// answer, and the bookkeeping then forgets the wait), its thread
// carried there first, so a worktree made at the old folder doesn't
// inherit it.
const noteEnded = (
  daemon: MirrorEngine["Service"],
  raw: MirrorSessionRaw,
  detail: string,
  worktreeId: string,
) => {
  if (worktreeId === "") return;
  daemon.moveHistory(localWorktreeIdOf(raw), worktreeId);
  daemon.noteEvent(worktreeId, "stopped", detail);
};

// Ends a mirror and leaves its copy where it is, an ordinary worktree
// of its device: the end of a mirror whose original is gone (the copy
// is then the only one left). The original's thread says why.
export const endMirrorKeepingCopy = (
  daemon: MirrorEngine["Service"],
  raw: MirrorSessionRaw,
  detail: string,
  worktreeId = worktreeIdNow(raw),
) =>
  Effect.gen(function* () {
    yield* daemon.terminate(raw.session);
    noteEnded(daemon, raw, detail, worktreeId);
  });

// Whether a session is a moved original's, waiting on its peer to
// re-open.
export const isWaitingOnPeer = (session: string): boolean =>
  waitingOnPeer.has(session);

export const STOPPED_WAITING_DETAIL =
  "This worktree moved, and its mirror was stopped before the other device could be reached to re-open it. The copy on the other device stays as a worktree.";

export const ORIGINAL_GONE_DETAIL =
  "This worktree was removed outside the app, so the mirror ended. The copy on the other device stays as a worktree.";

const FOLDER_TAKEN_DETAIL =
  "This worktree moved, and another worktree took its old folder before the other device could be reached to re-open the mirror, so the mirror ended. The copy on the other device stays as a worktree.";

const PEER_LATE_DETAIL =
  "This worktree moved, and the other device wasn't reached within 2 minutes to re-open the mirror, so the mirror ended. The copy on the other device stays as a worktree.";

const MIRRORED_AGAIN_DETAIL =
  "This worktree moved, and it was mirrored again before the device its earlier mirror waited on could be reached to re-open that one, so that mirror ended. Its copy there stays as a worktree.";

// The bookkeeping every snapshot of a running daemon is checked
// against (the root wires it to the daemon's onChange):
//   - the stops that came while the daemon was down, replayed,
//   - a session whose original is gone (removed from a terminal, from
//     Finder, or while the app was not running, none of which pass the
//     delete that stops its mirror): every session's root is looked at
//     on every snapshot, and one whose root is missing ends with its
//     copy kept. One whose original moved (the move recorded) re-opens
//     there instead, once its peer takes this device's calls, and ends
//     if another worktree takes the old folder first, if the worktree
//     it became is mirrored meanwhile, or if the peer comes too late.
//     The engine has more than one word for a root that went (a halt
//     when the copy stood still, a conflict at the root when the copy
//     had changed too, a problem at the root when the parent folder
//     went with it), and the look is one stat on a snapshot the engine
//     only sends on a change, so no word is waited for. Ended rather
//     than left there, since its Stop would otherwise remove the copy
//     that is now the only one there is, and the git half keeps
//     failing to read a worktree that is not there,
//   - a session a re-open replaced (MIRROR_LABEL_REPLACES) that
//     outlived it (a quit or a failed terminate between the re-open's
//     create and its terminate), so a pair never has two sessions.
// A terminate that fails is logged and asked again on a later
// snapshot.
const endingSessions = new Set<string>();
// The sessions whose root is being looked at, or was found gone and
// ended, kept until the engine stops listing them: snapshots overlap,
// and a sweep that starts between the end and the engine's next
// snapshot would find the session listed still and end it twice. A
// look that finds the root of a session not waiting on its peer, or
// can't see a waiting one's, a session left to wait, a move the look
// can't read, or an end that fails, forgets the mark, so the next
// snapshot looks again.
const rootLooks = new Set<string>();

// The sessions of a moved original whose re-open waits for the peer to
// take this device's calls, each with the id of the worktree the
// original became, the folder it was last found at, and when the wait
// began, kept until the engine stops listing them. Each is paused, so
// neither the engine's retry nor an admission brings it back on the old
// folder, which a worktree made there meanwhile would make another's.
const waitingOnPeer = new Map<
  string,
  { id: string; path: string; since: Stamp }
>();

// The longest a re-open waits for the peer: a peer coming up just after
// this device. A re-open is a new session, with no record of what the
// two sides last agreed on, so whatever changed on either side since
// the old session's last cycle comes back as a creation or a conflict,
// which sessions.ts's reopenMirror refuses on a pair that isn't
// settled. That includes the time the app was closed, which no wait
// bounds: the bound keeps the wait from adding much to it. A peer
// that comes later (asleep, or a v3 migration's peer upgraded later)
// finds the mirror ended, its copy kept.
const PEER_WAIT_MS = 2 * 60_000;

// The worktree a session's local side is now: a waiting one's is the
// worktree its original became, which its labels don't say yet.
const worktreeIdNow = (raw: MirrorSessionRaw): string =>
  waitingOnPeer.get(raw.session)?.id ?? localWorktreeIdOf(raw);

// Sessions a re-open is replacing right now (MirrorEngine's recreate): the
// re-open ends the old one itself once the new one is up, so the
// leftover sweep below must not race it to the terminate.
const recreating = new Set<string>();

export const isRecreating = (session: string): boolean =>
  recreating.has(session);

export const whileRecreating = <A, E, R>(
  session: string,
  run: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => recreating.add(session)),
    () => run,
    () => Effect.sync(() => recreating.delete(session)),
  );

// Worktrees an in-app delete or move is working on (Scripts
// withDeletesInflight): their root vanishing is that mutation, whose
// own follow-up stops or moves their mirrors, not a removal behind the
// app's back. Counted, since a stack cleanup holds several at once.
const holdingRoots = new Map<string, number>();

export function holdRootChecks(worktreeIds: readonly string[]): () => void {
  for (const id of worktreeIds) {
    holdingRoots.set(id, (holdingRoots.get(id) ?? 0) + 1);
  }
  return () => {
    for (const id of worktreeIds) {
      const left = (holdingRoots.get(id) ?? 1) - 1;
      if (left > 0) holdingRoots.set(id, left);
      else holdingRoots.delete(id);
    }
  };
}

// Whether a session's root is still there. Only "no such file" says it
// is gone, and not on a volume that isn't mounted (a drive unplugged,
// asleep, not mounted yet), whose every path reads as none: a folder
// macOS has not granted this app fails the look too, and neither may
// end a mirror.
export const rootExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      error.code !== "ENOENT" || unmountedVolume(path) !== null,
  );

// Where the store records a folder moved to, null when it records no
// move, undefined when the read fails: the store's read dies on a
// failure rather than fail, and a look that can't read the record leaves
// the session to the next one.
const recordedMove = (path: string) =>
  Effect.map(Effect.exit(Ops.wtFolderMovedTo(path)), (read) =>
    Exit.isSuccess(read) ? read.value : undefined,
  );

export const settleMirrorBookkeeping = Effect.gen(function* () {
  const daemon = yield* engineOrNull;
  // Off the running daemon's own snapshot: its ready comes before it.
  if (
    daemon === null ||
    (yield* daemon.status) !== "running" ||
    !(yield* daemon.fresh)
  ) {
    return;
  }
  const reach = yield* PeerReach;
  const ids = [...pendingStops];
  pendingStops.clear();
  yield* Effect.forEach(ids, (id) => endSessionsOnWorktree(daemon, id), {
    concurrency: "unbounded",
    discard: true,
  });

  const sessions = yield* mirrorSessions(daemon);
  const reopening = new Set<string>();
  const live = new Set(sessions.map((raw) => raw.session));
  for (const id of rootLooks) if (!live.has(id)) rootLooks.delete(id);
  for (const id of waitingOnPeer.keys()) {
    if (!live.has(id)) waitingOnPeer.delete(id);
  }
  const replaced = new Set(
    sessions
      .map((raw) => raw.labels[MIRROR_LABEL_REPLACES])
      .filter((id): id is string => id !== undefined),
  );
  yield* Effect.forEach(
    sessions,
    (raw) =>
      Effect.gen(function* () {
        if (endingSessions.has(raw.session)) return;
        if (replaced.has(raw.session)) {
          if (!recreating.has(raw.session)) {
            yield* endOnce(raw.session, daemon.terminate(raw.session));
          }
          return;
        }
        if (holdingRoots.has(worktreeIdNow(raw))) return;
        if (rootLooks.has(raw.session)) return;
        rootLooks.add(raw.session);
        const waiting = waitingOnPeer.get(raw.session);
        const end = (detail: string, worktreeId?: string) =>
          Effect.gen(function* () {
            const ended = yield* endOnce(
              raw.session,
              endMirrorKeepingCopy(daemon, raw, detail, worktreeId),
            );
            if (!ended) rootLooks.delete(raw.session);
          });
        if (yield* Effect.promise(() => rootExists(raw.localRoot))) {
          // The worktree came back to its folder (the folder it was found
          // at moved back): the wait is over, and the session stays
          // paused for a person's Resume, which keeps what the pair
          // agreed on.
          if (waiting !== undefined) {
            const movedBack = yield* recordedMove(waiting.path);
            if (movedBack === undefined) {
              rootLooks.delete(raw.session);
              return;
            }
            if (
              movedBack !== null &&
              worktreeIdFromPath(movedBack) === localWorktreeIdOf(raw)
            ) {
              waitingOnPeer.delete(raw.session);
            }
          }
          // A waiting session's old folder, there to see, is another
          // worktree's now. One the look can't see (its volume not
          // mounted) keeps waiting.
          const taken =
            waitingOnPeer.has(raw.session) &&
            (yield* Effect.promise(() =>
              access(raw.localRoot).then(
                () => true,
                () => false,
              ),
            ));
          if (taken) yield* end(FOLDER_TAKEN_DETAIL);
          else rootLooks.delete(raw.session);
          return;
        }
        // The v3 migration moved the original into wt/: the mirror
        // re-opens there, as after a move.
        const movedTo = yield* recordedMove(raw.localRoot);
        if (movedTo === undefined) {
          rootLooks.delete(raw.session);
          return;
        }
        if (
          movedTo !== null &&
          (yield* Effect.promise(() => rootExists(movedTo)))
        ) {
          const movedId = worktreeIdFromPath(movedTo);
          // The worktree it became mirrors on its own now, and a worktree
          // has one mirror.
          if (sessions.some((other) => localWorktreeIdOf(other) === movedId)) {
            yield* end(MIRRORED_AGAIN_DETAIL, movedId);
            return;
          }
          const now = yield* stamp;
          if (
            waiting !== undefined &&
            ageOf(waiting.since, now) > PEER_WAIT_MS
          ) {
            yield* end(PEER_LATE_DETAIL, movedId);
            return;
          }
          // The re-open needs the peer (the engine opens a session only
          // against both sides): one not taking this device's calls yet
          // (not reached at a start, away, or a switch of its off) waits,
          // paused, and is looked at again when it comes to
          // (MirrorEngineLayer's admissions).
          if (!reach.admits(raw.deviceId)) {
            waitingOnPeer.set(raw.session, {
              id: movedId,
              path: movedTo,
              since: waiting?.since ?? now,
            });
            rootLooks.delete(raw.session);
            if (!raw.paused) {
              yield* Effect.ignoreCause(daemon.pause(raw.session), {
                log: "Warn",
                message: "[mirror] a session waiting on its peer didn't pause",
              });
            }
            return;
          }
          // One re-open per worktree carries all of its sessions.
          if (reopening.has(raw.localRoot)) return;
          reopening.add(raw.localRoot);
          yield* moveMirrorsOfWorktree(localWorktreeIdOf(raw), {
            id: movedId,
            path: movedTo,
          });
          return;
        }
        yield* end(ORIGINAL_GONE_DETAIL);
      }),
    { concurrency: "unbounded", discard: true },
  );
});

const endOnce = <E, R>(session: string, end: Effect.Effect<unknown, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => endingSessions.add(session)),
    () =>
      end.pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn(
              `[mirror] could not end a session: ${errorWordsOf(error)}`,
            );
            return false;
          }),
        ),
      ),
    () => Effect.sync(() => endingSessions.delete(session)),
  );

// A worktree here was re-keyed: its id is path derived, so a move put it
// under a new one. What is kept under the old id follows: its thread,
// and each session on it, re-opened on the new path (MirrorEngine's
// recreate, the git follower's agreement carried across by the replaces
// label). The engine halted the old session the moment its root went,
// so nothing crossed meanwhile. A daemon that isn't running re-opens
// nothing: its first snapshot finds the session's root gone and the
// move recorded, and the bookkeeping runs this again once the peer
// takes this device's calls, within 2 minutes (settleMirrorBookkeeping).
// A re-open the peer cannot answer (it is away: the engine opens a
// session only against both sides) ends the mirror instead, the copy
// kept, and the thread says so. A session waiting to re-open into the
// worktree that moved is the moved one's now (worktreeIdNow).
export const moveMirrorsOfWorktree = (
  oldId: string,
  moved: { id: string; path: string },
) =>
  Effect.gen(function* () {
    const daemon = yield* engineOrNull;
    if (daemon === null) return;
    daemon.moveHistory(oldId, moved.id);
    for (const [session, waiting] of waitingOnPeer) {
      if (waiting.id === oldId) {
        waitingOnPeer.set(session, { ...waiting, id: moved.id });
      }
    }
    if ((yield* daemon.status) !== "running") return;
    const sessions = (yield* mirrorSessions(daemon)).filter(
      (raw) => localWorktreeIdOf(raw) === oldId,
    );
    yield* Effect.forEach(
      sessions,
      (raw) =>
        daemon
          .recreate(raw.session, {
            localRoot: moved.path,
            deviceId: raw.deviceId,
            projectId: raw.projectId,
            worktreeId: raw.worktreeId,
            remoteRoot: raw.remoteRoot,
            name: raw.name,
            localWorktreeId: moved.id,
            labels: carriedLabels(raw, {}),
            ignores: raw.ignores,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                daemon.noteEvent(moved.id, "resumed", "This worktree moved"),
              ),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* endOnce(raw.session, daemon.terminate(raw.session));
                daemon.noteEvent(
                  moved.id,
                  "stopped",
                  `This worktree moved and the mirror could not re-open (${errorWordsOf(error)}). The copy on the other device stays as a worktree.`,
                );
              }),
            ),
          ),
      { concurrency: "unbounded", discard: true },
    );
  });

// The engine persists its sessions, so they come back on every spawn:
// a boot that starts signed out, or a daemon that was down at the
// sign-out, would otherwise resume mirroring with peers of an account
// this device is not on. Nothing is asked before the shell's first
// report, which asks itself (handlers.ts applyAccount); after it, each
// session is asked about one time, so the snapshots while it ends do
// not end it again. A sign-out ends what was running itself and resets
// the sweep, so a session reported after it is asked again. Only the
// running daemon's own snapshot is asked about: the one that stands
// through a restart can end nothing.
export function createNoAccountSweep(deps: {
  sessions: () => readonly MirrorSessionRaw[];
  // Whether `sessions` is the running daemon's own (MirrorDaemon's fresh).
  fresh: () => boolean;
  // Undefined while the account is unknown.
  signedIn: () => boolean | undefined;
  end: () => void;
}): { run: () => void; reset: () => void } {
  const asked = new Set<string>();
  return {
    run: () => {
      if (!deps.fresh()) return;
      const signedIn = deps.signedIn();
      if (signedIn === undefined) return;
      const unasked = deps.sessions().filter((raw) => !asked.has(raw.session));
      if (unasked.length === 0) return;
      for (const raw of unasked) asked.add(raw.session);
      if (!signedIn) deps.end();
    },
    reset: () => asked.clear(),
  };
}

// Ends every mirror with a peer `stillOnAccount` refuses (this device
// signed out, or the peer was removed from the registry). The copy
// stays as an ordinary worktree, unlike mirror:stop's delete: a
// delete is only safe against a live peer confirming nothing is held
// here alone, and the peer is exactly what is gone. The worktree's
// thread says so. Failures are logged, not thrown, like
// stopMirrorsForWorktree. With `transfers`, the one-shot transfer
// sessions with such a peer go too: their tokens stay live, so the
// orphan reaper never would, and their wait then fails the transfer.
export const endMirrorsWithPeers = (
  stillOnAccount: (deviceId: string) => boolean,
  detail: string,
  opts: { transfers?: boolean } = {},
) =>
  Effect.gen(function* () {
    const daemon = yield* engineOrNull;
    // A daemon that isn't running ends nothing: the sessions it brings
    // back are swept as they come (createNoAccountSweep).
    if (daemon === null || (yield* daemon.status) !== "running") return;
    const candidates = opts.transfers
      ? yield* daemon.sessions
      : yield* mirrorSessions(daemon);
    yield* endSessions(
      daemon,
      candidates.filter((raw) => !stillOnAccount(raw.deviceId)),
      "a mirror with a device that left the account",
      detail,
    );
  });

export const LEFT_ACCOUNT_DETAIL =
  "This device left the account. The copy stays as a worktree.";

export const COPY_GONE_DETAIL =
  "The copy on the other device was deleted or moved";

const decodeRemoval = Schema.decodeUnknownOption(WorktreeRemovalSchema);

// A peer's announcement that one of its worktrees is gone
// (worktrees:removal). A mirror runs on the device holding the
// original, so a copy deleted on its own device leaves its session
// here, halted on a far root that no longer exists.
export const endMirrorsOnPeerRemoval = (deviceId: string, payload: unknown) => {
  const removal = decodeRemoval(payload);
  if (Option.isNone(removal) || removal.value.state !== "removed") {
    return Effect.void;
  }
  return endMirrorsIntoGoneCopy(
    deviceId,
    removal.value.projectId,
    removal.value.worktreeId,
  );
};

// The sessions into one of a peer's worktrees, known to be gone, end,
// and each original's thread says why. Already ended (the stop and the
// peer's announcement both get here), there is nothing to do.
export const endMirrorsIntoGoneCopy = (
  deviceId: string,
  projectId: string,
  worktreeId: string,
) =>
  Effect.gen(function* () {
    const daemon = yield* engineOrNull;
    if (daemon === null || (yield* daemon.status) !== "running") return;
    yield* endSessions(
      daemon,
      (yield* mirrorSessions(daemon)).filter(
        (raw) =>
          raw.deviceId === deviceId &&
          raw.projectId === projectId &&
          raw.worktreeId === worktreeId,
      ),
      "a mirror whose copy is gone",
      COPY_GONE_DETAIL,
    );
  });

// Each session ended, then noted "stopped" on its original's thread. A
// session that refuses to end is logged, not thrown.
const endSessions = (
  daemon: MirrorEngine["Service"],
  doomed: readonly MirrorSessionRaw[],
  what: string,
  detail: string,
) =>
  Effect.forEach(
    doomed,
    (raw) => {
      const worktreeId = worktreeIdNow(raw);
      return daemon.terminate(raw.session).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!isTransferSession(raw)) {
              noteEnded(daemon, raw, detail, worktreeId);
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            log.warn(`[mirror] could not end ${what}: ${errorWordsOf(error)}`),
          ),
        ),
      );
    },
    { concurrency: "unbounded", discard: true },
  );
