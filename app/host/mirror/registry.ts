// The mirror daemon's slot and the vocabulary around it: the labels the
// start orchestration writes on a session, the raw shapes the daemon
// reports, and the impl the root wires in following the setPortForwardEngine
// precedent. Separate from the mirror handler module so the worktree
// tombstone protocol (host/lib/scripts/index.ts withDeleteInflight)
// can stop a worktree's mirrors without importing that module (which
// reaches sync, which reaches worktrees).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import {
  MIRROR_LABEL_MODE,
  MIRROR_LABEL_REPLACES,
  type MirrorDaemonStatus,
  type MirrorEvent,
  type MirrorEventKind,
  type MirrorGitStatus,
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
  type MirrorSessionRaw,
  mirrorEngineBlocker,
} from "@shigomori/contracts/modules/mirror";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { WorktreeRemovalSchema } from "@shigomori/contracts/schemas/worktree";
import { implSlot } from "@host/lib/util/implSlot";
import { peerMirrorFor } from "@host/ipc/peerSync";
import {
  dropMirrorInvitesWithPeers,
  forgetMirrorInvitesOf,
} from "@host/mirror/invites";
import { log } from "@shared/log";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import * as Ops from "@host/lib/engineOps";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own. Ids only: the
// engine refuses label values outside its alphabet, and the branch is
// the local worktree's to report.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";
export const MIRROR_LABEL_LOCAL_WORKTREE = "localWorktreeId";
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

// The create request the daemon takes (file-sync/engine.go
// mirrorRequest, the create fields).
export type MirrorCreateInput = {
  localRoot: string;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  remoteRoot: string;
  name: string;
  // This device's own worktree id, carried to the peer in the stream
  // preface so its sidebar can fold the pair. A field of its own, not
  // a label the engine would have to know the key of.
  localWorktreeId: string;
  labels: Record<string, string>;
  ignores: readonly string[];
  // A pull (file-sync/engine.go mirrorRequest.pull): files flow one
  // way, remote to local, and nothing here reaches the peer. The
  // transplant's one-shot transfer. Absent, a two-way mirror.
  pull?: boolean;
  // A push (mirrorRequest.push), the pull turned around: local to
  // remote, and nothing the peer holds lands here. A sent worktree's
  // one-shot transfer.
  push?: boolean;
  // A replica (mirrorRequest.replica): local to remote, the remote
  // made an exact copy. A mirror start's first pass.
  replica?: boolean;
};

// The daemon as the mirror surfaces use it, wired by the root from the
// daemon service, the git follower and the threads.
export type MirrorImpl = {
  status: Effect.Effect<MirrorDaemonStatus>;
  sessions: Effect.Effect<readonly MirrorSessionRaw[]>;
  create: (input: MirrorCreateInput) => Effect.Effect<string, MirrorError>;
  // Ends a session and opens a fresh one in its place, whatever hangs
  // off the old id (the git follower's agreement) carried across.
  recreate: (
    session: string,
    input: MirrorCreateInput,
  ) => Effect.Effect<string, MirrorError>;
  terminate: (session: string) => Effect.Effect<void, MirrorError>;
  pause: (session: string) => Effect.Effect<void, MirrorError>;
  resume: (session: string) => Effect.Effect<void, MirrorError>;
  // The git follower's verdict for a session (host/mirror/gitFollow.ts).
  gitStatus: (session: string) => MirrorGitStatus | undefined;
  // The verdict looked at again now, for a decision that must not
  // read a cached one (the stop's safety check).
  refreshGit: (session: string) => Effect.Effect<MirrorGitStatus | undefined>;
  // The mirror's thread of events, by local worktree (host/mirror/
  // history.ts), and the way a control op adds to it.
  history: (localWorktreeId: string) => readonly MirrorEvent[];
  noteEvent: (
    localWorktreeId: string,
    kind: MirrorEventKind,
    detail: string,
  ) => void;
  // Drops a worktree's thread, once the worktree itself is gone.
  forgetHistory: (localWorktreeId: string) => void;
  // Moves a worktree's thread to the id it has after a move.
  moveHistory: (from: string, to: string) => void;
};

// What a mirror operation refused, in words for the user.
export class MirrorError extends Schema.TaggedError<MirrorError>()(
  "MirrorError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

// The local worktree a session runs on, "" on a session that predates
// the label.
export function localWorktreeIdOf(raw: MirrorSessionRaw | undefined): string {
  return raw?.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "";
}

// The ignore mode a session's labels carry, "everything" when none.
const isMirrorIgnoreMode = Schema.is(MirrorIgnoreModeSchema);
export function ignoreModeOf(labels: Record<string, string>): MirrorIgnoreMode {
  const mode = labels[MIRROR_LABEL_IGNORE_MODE];
  return isMirrorIgnoreMode(mode) ? mode : "everything";
}

// The daemon (engine), or null before it is wired (engineOrNull), for
// a caller that has a sensible answer without one.
const {
  set: setMirrorImpl,
  get: engine,
  orNull: engineOrNull,
} = implSlot<MirrorImpl>("mirror handler invoked before the daemon was wired");
export { setMirrorImpl, engine, engineOrNull };

// The engine when it can take a session, or the reason it cannot:
// the mirror start and the transplant's file transfer both begin here.
export const requireRunningEngine = Effect.suspend(() => {
  const daemon = engine();
  return Effect.flatMap(daemon.status, (status) => {
    const blocker = mirrorEngineBlocker(status);
    return blocker === undefined
      ? Effect.succeed(daemon)
      : Effect.fail(new MirrorError({ reason: blocker }));
  });
});

// The daemon's sessions that ARE mirrors: a transplant's one-shot
// transfer (host/mirror/oneShot.ts) rides the same daemon under a
// label, and nothing that lists, follows or narrates mirrors should
// see it. The transfer finds its own session on the raw list. Nor a
// session in a mode this build does not know.
export const mirrorSessions = (daemon: Pick<MirrorImpl, "sessions">) =>
  Effect.map(daemon.sessions, (sessions) =>
    sessions.filter((raw) => {
      const mode = modeOf(raw.labels);
      return mode === "mirror" || mode === "mirror-branch";
    }),
  );

// Which transfer a session is, written into its mode
// ("transfer-<token>"): one token per transfer, live from before its create is sent until
// its pull has ended it. A transfer session whose token is not live
// here has nobody waiting on it, and the host ends it on sight, since no
// mirror surface would ever show it. That covers every way one gets
// left behind: a quit or a crash mid-transfer (the engine persists its
// sessions, and the next launch knows none of their tokens), a create
// that was rejected after the engine had made the session, and a
// terminate that failed. It never covers a transfer still running,
// even on the snapshot that names the session before the create's own
// reply lands, because the token is live first. A label from before
// the tokens (a plain "1") matches none.
const liveTransfers = new Set<string>();

export function beginTransfer(): string {
  const token = randomUUID();
  liveTransfers.add(token);
  return token;
}

export function endTransfer(token: string): void {
  liveTransfers.delete(token);
}

export function isOrphanedTransfer(raw: MirrorSessionRaw): boolean {
  const token = transferTokenOf(raw.labels);
  return token !== null && !liveTransfers.has(token);
}

export const findSession = (daemon: MirrorImpl, session: string) =>
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
// A copy a peer mirrored into here takes its invitation with it
// (invites.ts), daemon or no daemon.
//
// A daemon that is not running (restarting, or still starting at
// boot) lists no sessions, so the id waits in `pendingStops` and the
// first snapshot of a running daemon ends what it names
// (settleMirrorBookkeeping). The copy a peer holds stays a worktree of
// its own, and its device is told it is no longer mirrored
// (mirror:release).
const pendingStops = new Set<string>();

export const stopMirrorsForWorktree = (localWorktreeId: string) =>
  Effect.gen(function* () {
    forgetMirrorInvitesOf(localWorktreeId);
    const daemon = engineOrNull();
    // Unwired (a check, a surface that never mounts the daemon) there is
    // nothing mirroring anything.
    if (daemon === null) return;
    if ((yield* daemon.status) !== "running") {
      pendingStops.add(localWorktreeId);
    }
    yield* endSessionsOnWorktree(daemon, localWorktreeId);
    // The worktree is gone, so its thread has no page left to show on.
    daemon.forgetHistory(localWorktreeId);
  });

const endSessionsOnWorktree = (daemon: MirrorImpl, localWorktreeId: string) =>
  Effect.flatMap(daemon.sessions, (sessions) =>
    Effect.forEach(
      sessions.filter(
        (raw) => raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] === localWorktreeId,
      ),
      (raw) =>
        daemon.terminate(raw.session).pipe(
          Effect.andThen(
            isTransferSession(raw) ? Effect.void : releaseCopy(raw),
          ),
          Effect.catch((error) =>
            Effect.sync(() =>
              log.warn(
                `[mirror] could not stop the mirror of a worktree being deleted: ${errorMessageOf(error)}`,
              ),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    ),
  );

// Tells the copy's device its copy is no longer mirrored, so the
// invitation it left for this device (host/mirror/invites.ts) goes and
// the copy is an ordinary worktree there. Best effort: a peer away, or
// on a build without the verb, keeps the invitation until the copy is
// deleted, which only ever admits this device's calls on that copy.
const releaseCopy = (raw: MirrorSessionRaw) =>
  Effect.asVoid(
    Effect.forkDetach(
      Effect.ignore(
        peerMirrorFor(raw.deviceId).release({
          projectId: raw.projectId,
          worktreeId: raw.worktreeId,
        }),
      ),
    ),
  );

// Ends a mirror and leaves its copy where it is, an ordinary worktree
// of its device: the end of a mirror
// whose original is gone (the copy is then the only one left). The
// original's thread says why.
export const endMirrorKeepingCopy = (
  daemon: MirrorImpl,
  raw: MirrorSessionRaw,
  detail: string,
) =>
  Effect.gen(function* () {
    yield* daemon.terminate(raw.session);
    yield* releaseCopy(raw);
    daemon.noteEvent(localWorktreeIdOf(raw), "stopped", detail);
  });

export const ORIGINAL_GONE_DETAIL =
  "This worktree was removed outside the app, so the mirror ended. The copy on the other device stays as a worktree.";

// The bookkeeping every snapshot of a running daemon is checked
// against (the root wires it to the daemon's onChange):
//   - the stops that came while the daemon was down, replayed,
//   - a session whose original is gone (removed from a terminal, from
//     Finder, or while the app was not running, none of which pass the
//     delete that stops its mirror): every session's root is looked at
//     on every snapshot, and one whose root is missing ends with its
//     copy kept. The engine has more than one word for a root that
//     went (a halt when the copy stood still, a conflict at the root
//     when the copy had changed too, a problem at the root when the
//     parent folder went with it), and the look is one stat on a
//     snapshot the engine only sends on a change, so no word is
//     waited for. Ended rather than left there, since its Stop would
//     otherwise remove the copy that is now the only one there is,
//     and the git half keeps failing to read a worktree that is not
//     there,
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
// look that finds the root, or an end that fails, forgets the mark,
// so the next snapshot looks again.
const rootLooks = new Set<string>();

// Sessions a re-open is replacing right now (MirrorImpl.recreate): the
// re-open ends the old one itself once the new one is up, so the
// leftover sweep below must not race it to the terminate.
const recreating = new Set<string>();

export const whileRecreating = <A, E, R>(
  session: string,
  run: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => recreating.add(session)),
    () => run,
    () => Effect.sync(() => recreating.delete(session)),
  );

// Worktrees an in-app delete or move is working on (host/lib/scripts
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
// is gone: a volume not mounted yet, or a folder macOS has not granted
// this app, fails the look too, and must not end a mirror.
export const rootExists = (path: string) =>
  access(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );

export const settleMirrorBookkeeping = Effect.gen(function* () {
  const daemon = engineOrNull();
  if (daemon === null || (yield* daemon.status) !== "running") return;
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
        if (holdingRoots.has(localWorktreeIdOf(raw))) return;
        if (rootLooks.has(raw.session)) return;
        rootLooks.add(raw.session);
        if (yield* Effect.promise(() => rootExists(raw.localRoot))) {
          rootLooks.delete(raw.session);
          return;
        }
        // The v3 migration moved the original into wt/: the mirror
        // re-opens there, as after a move.
        const movedTo = yield* Ops.wtFolderMovedTo(raw.localRoot).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (
          movedTo !== null &&
          (yield* Effect.promise(() => rootExists(movedTo)))
        ) {
          // One re-open per worktree carries all of its sessions.
          if (reopening.has(raw.localRoot)) return;
          reopening.add(raw.localRoot);
          yield* moveMirrorsOfWorktree(localWorktreeIdOf(raw), {
            id: worktreeIdFromPath(movedTo),
            path: movedTo,
          });
          return;
        }
        const ended = yield* endOnce(
          raw.session,
          endMirrorKeepingCopy(daemon, raw, ORIGINAL_GONE_DETAIL),
        );
        if (!ended) rootLooks.delete(raw.session);
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
              `[mirror] could not end a session: ${errorMessageOf(error)}`,
            );
            return false;
          }),
        ),
      ),
    () => Effect.sync(() => endingSessions.delete(session)),
  );

// A move (worktrees:relocate) put the original somewhere else. The id
// is path derived, so to the engine it is a new worktree: each session
// on the old one re-opens on the new path (MirrorImpl.recreate, the
// git follower's agreement carried across by the replaces label), and
// the thread moves with it. The engine halted the old session the
// moment its root went, so nothing crossed meanwhile. A re-open the
// peer cannot answer (it is away: the engine opens a session only
// against both sides) ends the mirror instead, the copy kept, and the
// thread says so.
export const moveMirrorsOfWorktree = (
  oldId: string,
  moved: { id: string; path: string },
) =>
  Effect.gen(function* () {
    const daemon = engineOrNull();
    if (daemon === null) return;
    if ((yield* daemon.status) !== "running") {
      // Nothing to re-open against: the stop waits for the daemon like a
      // delete's, and the copy stays.
      pendingStops.add(oldId);
      return;
    }
    const sessions = (yield* mirrorSessions(daemon)).filter(
      (raw) => localWorktreeIdOf(raw) === oldId,
    );
    if (sessions.length === 0) return;
    daemon.moveHistory(oldId, moved.id);
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
            labels: carriedLabels(raw, {
              [MIRROR_LABEL_LOCAL_WORKTREE]: moved.id,
            }),
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
                yield* endOnce(
                  raw.session,
                  Effect.andThen(
                    daemon.terminate(raw.session),
                    releaseCopy(raw),
                  ),
                );
                daemon.noteEvent(
                  moved.id,
                  "stopped",
                  `This worktree moved and the mirror could not re-open (${errorMessageOf(error)}). The copy on the other device stays as a worktree.`,
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
// this device is not on. Each session is asked about once, signed in
// or not, so one failed credential read (it reads as signed out) ends
// nothing already running. A sign-out ends what was running itself and
// resets the sweep, so a session reported after it is asked again.
export function createNoAccountSweep(deps: {
  sessions: () => readonly MirrorSessionRaw[];
  signedIn: () => boolean;
  end: () => void;
}): { run: () => void; reset: () => void } {
  const asked = new Set<string>();
  return {
    run: () => {
      const fresh = deps.sessions().filter((raw) => !asked.has(raw.session));
      if (fresh.length === 0) return;
      // Asked before marking: a check that throws leaves them to ask again.
      const signedIn = deps.signedIn();
      for (const raw of fresh) asked.add(raw.session);
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
// The invitations such peers held go too (invites.ts), daemon or no
// daemon.
export const endMirrorsWithPeers = (
  stillOnAccount: (deviceId: string) => boolean,
  detail: string,
  opts: { transfers?: boolean } = {},
) =>
  Effect.gen(function* () {
    dropMirrorInvitesWithPeers(stillOnAccount);
    const daemon = engineOrNull();
    if (daemon === null) return;
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
    const daemon = engineOrNull();
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
  daemon: MirrorImpl,
  doomed: readonly MirrorSessionRaw[],
  what: string,
  detail: string,
) =>
  Effect.forEach(
    doomed,
    (raw) =>
      daemon.terminate(raw.session).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (isTransferSession(raw)) return;
            const localWorktreeId = localWorktreeIdOf(raw);
            if (localWorktreeId !== "") {
              daemon.noteEvent(localWorktreeId, "stopped", detail);
            }
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            log.warn(
              `[mirror] could not end ${what}: ${errorMessageOf(error)}`,
            ),
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
