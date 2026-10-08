// The mirror daemon's slot and the vocabulary around it: the labels the
// start orchestration writes on a session, the raw shapes the daemon
// reports, and the impl main wires in following the setPortForwardEngine
// precedent. Separate from the mirror handler module so the worktree
// tombstone protocol (host/lib/scripts/index.ts withDeleteInflight)
// can stop a worktree's mirrors without importing that module (which
// reaches sync, which reaches worktrees).
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import {
  isHaltedStatus,
  isTransferSession,
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_REPLACES,
  MIRROR_LABEL_TRANSFER,
  type MirrorDaemonStatus,
  type MirrorEvent,
  type MirrorEventKind,
  type MirrorGitStatus,
  type MirrorIgnoreMode,
  MirrorIgnoreModeSchema,
  type MirrorSessionRaw,
  mirrorEngineBlocker,
} from "@shared/ipc/modules/mirror";
import { errorMessageOf } from "@shared/errors";
import { WorktreeRemovalSchema } from "@shared/schemas/worktree";
import { implSlot } from "@host/lib/util/implSlot";
import { peerMirrorApiFor } from "@host/ipc/peerSync";
import {
  dropMirrorInvitesWithPeers,
  forgetMirrorInvitesOf,
} from "@host/mirror/invites";

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

// What the daemon reports for one session, before annotation (shared/
// ipc/modules/mirror.ts), re-exported for the host's own callers.
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

export type MirrorImpl = {
  status: () => MirrorDaemonStatus;
  sessions: () => readonly MirrorSessionRaw[];
  create: (input: MirrorCreateInput) => Promise<string>;
  // Ends a session and opens a fresh one in its place, whatever hangs
  // off the old id (the git follower's agreement) carried across.
  recreate: (session: string, input: MirrorCreateInput) => Promise<string>;
  terminate: (session: string) => Promise<unknown>;
  pause: (session: string) => Promise<unknown>;
  resume: (session: string) => Promise<unknown>;
  // The git follower's verdict for a session (host/mirror/gitFollow.ts).
  gitStatus: (session: string) => MirrorGitStatus | undefined;
  // The verdict looked at again now, for a decision that must not
  // read a cached one (the stop's safety check).
  refreshGit: (session: string) => Promise<MirrorGitStatus | undefined>;
  // The mirror's thread of events, by local worktree (main/core/mirror/
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
export function requireRunningEngine(): MirrorImpl {
  const daemon = engine();
  const blocker = mirrorEngineBlocker(daemon.status());
  if (blocker !== undefined) throw new Error(blocker);
  return daemon;
}

// The daemon's sessions that ARE mirrors: a transplant's one-shot
// transfer (host/mirror/oneShot.ts) rides the same daemon under a
// label, and nothing that lists, follows or narrates mirrors should
// see it. The transfer finds its own session on the raw list. Nor a
// legacy mirror (below), which the follower would read the wrong way
// round and which is ended on sight.
export function mirrorSessions(
  daemon: Pick<MirrorImpl, "sessions">,
): MirrorSessionRaw[] {
  return daemon
    .sessions()
    .filter((raw) => !isTransferSession(raw) && !isLegacyMirror(raw));
}

// A mirror an older build started from the copy's device: it ran
// there, its local side the copy, and carries no copySide label (every
// start now writes it, shared/ipc/modules/mirror.ts). A mirror runs on
// the device holding the original now, so such a session is ended the
// first time the engine reports it (main wires this to its snapshots):
// the session only, never a worktree, and its thread (the copy's page)
// says why and what to do. Each is asked once, like the orphaned
// transfers: a terminate that fails is logged.
function isLegacyMirror(raw: MirrorSessionRaw): boolean {
  return (
    !isTransferSession(raw) && raw.labels[MIRROR_LABEL_COPY_SIDE] !== "remote"
  );
}

export const LEGACY_MIRROR_DETAIL =
  "This mirror was started from the copy's device, which this version no longer does. Start it again from the original's page.";

const endedLegacy = new Set<string>();

export async function endLegacyMirrors(): Promise<void> {
  const daemon = engineOrNull();
  if (daemon === null || daemon.status() !== "running") return;
  const doomed = daemon
    .sessions()
    .filter((raw) => isLegacyMirror(raw) && !endedLegacy.has(raw.session));
  await Promise.all(
    doomed.map(async (raw) => {
      endedLegacy.add(raw.session);
      try {
        await daemon.terminate(raw.session);
      } catch (error) {
        console.warn(
          `[mirror] could not end a mirror started from the copy's device: ${errorMessageOf(error)}`,
        );
        return;
      }
      daemon.noteEvent(localWorktreeIdOf(raw), "halted", LEGACY_MIRROR_DETAIL);
    }),
  );
}

// Which transfer a session is, written as the transfer label's value:
// one token per transfer, live from before its create is sent until
// its pull has ended it. A transfer session whose token is not live
// here has nobody waiting on it, and main ends it on sight, since no
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
  return (
    isTransferSession(raw) &&
    !liveTransfers.has(raw.labels[MIRROR_LABEL_TRANSFER] ?? "")
  );
}

export function findSession(
  daemon: MirrorImpl,
  session: string,
): MirrorSessionRaw | undefined {
  return daemon.sessions().find((raw) => raw.session === session);
}

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

export async function stopMirrorsForWorktree(
  localWorktreeId: string,
): Promise<void> {
  forgetMirrorInvitesOf(localWorktreeId);
  const daemon = engineOrNull();
  // Unwired (a check, a surface that never mounts the daemon) there is
  // nothing mirroring anything.
  if (daemon === null) return;
  if (daemon.status() !== "running") pendingStops.add(localWorktreeId);
  await endSessionsOnWorktree(daemon, localWorktreeId);
  // The worktree is gone, so its thread has no page left to show on.
  daemon.forgetHistory(localWorktreeId);
}

async function endSessionsOnWorktree(
  daemon: MirrorImpl,
  localWorktreeId: string,
): Promise<void> {
  const doomed = daemon
    .sessions()
    .filter(
      (raw) => raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] === localWorktreeId,
    );
  await Promise.all(
    doomed.map(async (raw) => {
      try {
        await daemon.terminate(raw.session);
      } catch (error) {
        console.warn(
          `[mirror] could not stop the mirror of a worktree being deleted: ${errorMessageOf(error)}`,
        );
        return;
      }
      if (!isTransferSession(raw)) releaseCopy(raw);
    }),
  );
}

// Tells the copy's device its copy is no longer mirrored, so the
// invitation it left for this device (host/mirror/invites.ts) goes and
// the copy is an ordinary worktree there. Best effort: a peer away, or
// on a build without the verb, keeps the invitation until the copy is
// deleted, which only ever admits this device's calls on that copy.
function releaseCopy(raw: MirrorSessionRaw): void {
  void Promise.resolve()
    .then(() =>
      peerMirrorApiFor(raw.deviceId).release({
        projectId: raw.projectId,
        worktreeId: raw.worktreeId,
      }),
    )
    .catch(() => {});
}

// Ends a mirror and leaves its copy where it is, an ordinary worktree
// of its device: the end of a mirror
// whose original is gone (the copy is then the only one left). The
// original's thread says why.
export async function endMirrorKeepingCopy(
  daemon: MirrorImpl,
  raw: MirrorSessionRaw,
  detail: string,
): Promise<void> {
  await daemon.terminate(raw.session);
  releaseCopy(raw);
  daemon.noteEvent(localWorktreeIdOf(raw), "stopped", detail);
}

export const ORIGINAL_GONE_DETAIL =
  "This worktree was removed outside the app, so the mirror ended. The copy on the other device stays as a worktree.";

// The bookkeeping every snapshot of a running daemon is checked
// against (main wires it to the daemon's onChange):
//   - the stops that came while the daemon was down, replayed,
//   - a session whose original is gone (removed from a terminal, from
//     Finder, or while the app was not running, none of which pass the
//     delete that stops its mirror): the engine halts on a root that
//     disappeared, so a halted session's root is looked at, and one
//     whose root is missing ends with its copy kept. Ended rather than
//     left halted, since its Stop would otherwise remove the copy that
//     is now the only one there is,
//   - a session a re-open replaced (MIRROR_LABEL_REPLACES) that
//     outlived it (a quit or a failed terminate between the re-open's
//     create and its terminate), so a pair never has two sessions.
// Each session is asked once per state, and a terminate that fails is
// logged and asked again on a later snapshot.
const checkedRoots = new Set<string>();
const endingSessions = new Set<string>();

// Sessions a re-open is replacing right now (MirrorImpl.recreate): the
// re-open ends the old one itself once the new one is up, so the
// leftover sweep below must not race it to the terminate.
const recreating = new Set<string>();

export async function whileRecreating<T>(
  session: string,
  run: () => Promise<T>,
): Promise<T> {
  recreating.add(session);
  try {
    return await run();
  } finally {
    recreating.delete(session);
  }
}

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

export async function settleMirrorBookkeeping(): Promise<void> {
  const daemon = engineOrNull();
  if (daemon === null || daemon.status() !== "running") return;
  const ids = [...pendingStops];
  pendingStops.clear();
  await Promise.all(ids.map((id) => endSessionsOnWorktree(daemon, id)));

  const sessions = mirrorSessions(daemon);
  const live = new Set(sessions.map((raw) => raw.session));
  for (const key of checkedRoots) {
    if (!live.has(key.slice(0, key.lastIndexOf(":")))) checkedRoots.delete(key);
  }
  const replaced = new Set(
    sessions
      .map((raw) => raw.labels[MIRROR_LABEL_REPLACES])
      .filter((id): id is string => id !== undefined),
  );
  await Promise.all(
    sessions.map(async (raw) => {
      if (endingSessions.has(raw.session)) return;
      if (replaced.has(raw.session)) {
        if (!recreating.has(raw.session)) {
          await endOnce(raw.session, () => daemon.terminate(raw.session));
        }
        return;
      }
      if (holdingRoots.has(localWorktreeIdOf(raw))) return;
      // Looked at on first sight (a boot after the root went) and on
      // every halt, never on the busy states a live mirror cycles
      // through. A failed end forgets the look, so a later snapshot
      // tries again.
      const key = `${raw.session}:${isHaltedStatus(raw.status) ? "halted" : "seen"}`;
      if (checkedRoots.has(key)) return;
      checkedRoots.add(key);
      if (await rootExists(raw.localRoot)) return;
      const ended = await endOnce(raw.session, () =>
        endMirrorKeepingCopy(daemon, raw, ORIGINAL_GONE_DETAIL),
      );
      if (!ended) checkedRoots.delete(key);
    }),
  );
}

async function endOnce(
  session: string,
  end: () => Promise<unknown>,
): Promise<boolean> {
  endingSessions.add(session);
  try {
    await end();
    return true;
  } catch (error) {
    console.warn(`[mirror] could not end a session: ${errorMessageOf(error)}`);
    return false;
  } finally {
    endingSessions.delete(session);
  }
}

// A move (worktrees:relocate) put the original somewhere else. The id
// is path derived, so to the engine it is a new worktree: each session
// on the old one re-opens on the new path (MirrorImpl.recreate, the
// git follower's agreement carried across by the replaces label), and
// the thread moves with it. The engine halted the old session the
// moment its root went, so nothing crossed meanwhile. A re-open the
// peer cannot answer (it is away: the engine opens a session only
// against both sides) ends the mirror instead, the copy kept, and the
// thread says so.
export async function moveMirrorsOfWorktree(
  oldId: string,
  moved: { id: string; path: string },
): Promise<void> {
  const daemon = engineOrNull();
  if (daemon === null) return;
  if (daemon.status() !== "running") {
    // Nothing to re-open against: the stop waits for the daemon like a
    // delete's, and the copy stays.
    pendingStops.add(oldId);
    return;
  }
  const sessions = mirrorSessions(daemon).filter(
    (raw) => localWorktreeIdOf(raw) === oldId,
  );
  if (sessions.length === 0) return;
  daemon.moveHistory(oldId, moved.id);
  await Promise.all(
    sessions.map(async (raw) => {
      try {
        await daemon.recreate(raw.session, {
          localRoot: moved.path,
          deviceId: raw.deviceId,
          projectId: raw.projectId,
          worktreeId: raw.worktreeId,
          remoteRoot: raw.remoteRoot,
          name: raw.name,
          localWorktreeId: moved.id,
          labels: {
            ...raw.labels,
            [MIRROR_LABEL_LOCAL_WORKTREE]: moved.id,
            [MIRROR_LABEL_REPLACES]: raw.session,
          },
          ignores: raw.ignores,
        });
        daemon.noteEvent(moved.id, "resumed", "This worktree moved");
      } catch (error) {
        await endOnce(raw.session, async () => {
          await daemon.terminate(raw.session);
          releaseCopy(raw);
        });
        daemon.noteEvent(
          moved.id,
          "stopped",
          `This worktree moved and the mirror could not re-open (${errorMessageOf(error)}). The copy on the other device stays as a worktree.`,
        );
      }
    }),
  );
}

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
export async function endMirrorsWithPeers(
  stillOnAccount: (deviceId: string) => boolean,
  detail: string,
  opts: { transfers?: boolean } = {},
): Promise<void> {
  dropMirrorInvitesWithPeers(stillOnAccount);
  const daemon = engineOrNull();
  if (daemon === null) return;
  const candidates = opts.transfers
    ? daemon.sessions()
    : mirrorSessions(daemon);
  await endSessions(
    daemon,
    candidates.filter((raw) => !stillOnAccount(raw.deviceId)),
    "a mirror with a device that left the account",
    detail,
  );
}

export const COPY_GONE_DETAIL =
  "The copy on the other device was deleted or moved";

const decodeRemoval = Schema.decodeUnknownOption(WorktreeRemovalSchema);

// A peer's announcement that one of its worktrees is gone
// (worktrees:removal). A mirror runs on the device holding the
// original, so a copy deleted on its own device leaves its session
// here, halted on a far root that no longer exists.
export function endMirrorsOnPeerRemoval(
  deviceId: string,
  payload: unknown,
): Promise<void> {
  const removal = decodeRemoval(payload);
  if (Option.isNone(removal) || removal.value.state !== "removed") {
    return Promise.resolve();
  }
  return endMirrorsIntoGoneCopy(
    deviceId,
    removal.value.projectId,
    removal.value.worktreeId,
  );
}

// The sessions into one of a peer's worktrees, known to be gone, end,
// and each original's thread says why. Already ended (the stop and the
// peer's announcement both get here), there is nothing to do.
export async function endMirrorsIntoGoneCopy(
  deviceId: string,
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const daemon = engineOrNull();
  if (daemon === null || daemon.status() !== "running") return;
  await endSessions(
    daemon,
    mirrorSessions(daemon).filter(
      (raw) =>
        raw.deviceId === deviceId &&
        raw.projectId === projectId &&
        raw.worktreeId === worktreeId,
    ),
    "a mirror whose copy is gone",
    COPY_GONE_DETAIL,
  );
}

// Each session ended, then noted "stopped" on its original's thread. A
// session that refuses to end is logged, not thrown.
async function endSessions(
  daemon: MirrorImpl,
  doomed: readonly MirrorSessionRaw[],
  what: string,
  detail: string,
): Promise<void> {
  await Promise.all(
    doomed.map(async (raw) => {
      try {
        await daemon.terminate(raw.session);
      } catch (error) {
        console.warn(
          `[mirror] could not end ${what}: ${errorMessageOf(error)}`,
        );
        return;
      }
      if (isTransferSession(raw)) return;
      const localWorktreeId = localWorktreeIdOf(raw);
      if (localWorktreeId !== "") {
        daemon.noteEvent(localWorktreeId, "stopped", detail);
      }
    }),
  );
}
