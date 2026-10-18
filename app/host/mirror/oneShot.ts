// A transplant's file carrier: the mirror engine, run once. The pull
// has landed the branch and the capture through git. What git never
// carries (the ignored files the leave-out rule admits) crosses here,
// as one session between the new worktree and the source, held until
// its first full cycle has settled, then ended. A send runs the same
// session the other way: this device holds the source and pushes to
// the worktree the peer just created. Either way the session runs on
// the device that started the move, since it reaches the other side
// (mirror:openStream) through that side's grant, the one the move
// already rode: run from the destination of a send, it would need the
// source's grant too. Labelled a transfer so
// nothing that lists, follows or narrates mirrors sees it
// (registry.ts mirrorSessions). Nothing here fails the pull: the
// worktree is real either way, and the outcome (crossed, with how
// many conflicts, or why not) rides the pull's result.
import { errorWordsOf } from "@host/lib/errorWords";
import {
  isHaltedStatus,
  MIRROR_LABEL_MODE,
} from "@shigomori/contracts/modules/mirror";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  beginTransfer,
  endTransfer,
  findSession,
  MIRROR_LABEL_LOCAL_WORKTREE,
  transferModeFor,
  type MirrorSessionRaw,
  requireRunningEngine,
} from "./registry";
import type { MirrorEngine } from "./MirrorEngine";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";
import { log } from "@shared/log";

export type TransferFilesResult = {
  crossed: boolean;
  // Paths both sides held with different content when the session
  // opened (a setup script's output against the source's, say). The
  // engine leaves both alone, so the copy here keeps its own version.
  conflicts: number;
  error?: string;
};

const POLL_MS = 250;
// The daemon's snapshots trail its answers (file-sync/engine.go
// throttles them), so a session its create just made can be missing
// from the last one, and a daemon that isn't running lists the sessions
// it had, which nothing carries. Missing, or with no daemon running, for
// longer than this, the transfer is lost.
const MISSING_CEILING_MS = 10_000;
// An error with no cycle behind it for this long is a session that
// cannot connect (the peer's engine, the grant), not a slow one.
const CONNECT_CEILING_MS = 60_000;
// A whole node_modules over a slow link takes as long as it takes. The
// ceiling is for a session that never settles.
const SETTLE_CEILING_MS = 30 * 60_000;

function failed(error: string): TransferFilesResult {
  return { crossed: false, conflicts: 0, error };
}

// An interrupt (the move's cancel) ends the session where it stands, a
// create the cancel outran included (the host's sweep is the backstop, by
// the token). The caller decides what becomes of the worktree.
export const transferFilesOnce = (
  input: {
    localRoot: string;
    // The local worktree's id, the one label a session must carry:
    // the worktree delete stops whatever runs on it by that label.
    localWorktreeId: string;
    // The peer's half. The source of a pull, the destination of a push.
    sourceDeviceId: string;
    sourceProjectId: string;
    sourceWorktreeId: string;
    remoteRoot: string;
    name: string;
    ignores: readonly string[];
    // Which way the files flow. Absent, a pull: the peer's come here.
    // A replica pushes and makes the peer's side an exact copy (a
    // mirror start's first pass, host/ipc/modules/mirror.ts).
    direction?: "pull" | "push" | "replica";
  },
  onProgress: (bytes: number, totalBytes: number) => void,
): Effect.Effect<TransferFilesResult, never, MirrorEngine> =>
  Effect.acquireUseRelease(
    Effect.sync(beginTransfer),
    (token) =>
      Effect.gen(function* () {
        const daemon = yield* requireRunningEngine;
        // Ended whatever happens: after the terminate, so the host's sweep
        // only picks the session up when that failed.
        return yield* Effect.acquireUseRelease(
          Effect.uninterruptible(
            daemon.create({
              localRoot: input.localRoot,
              deviceId: input.sourceDeviceId,
              projectId: input.sourceProjectId,
              worktreeId: input.sourceWorktreeId,
              remoteRoot: input.remoteRoot,
              name: input.name,
              localWorktreeId: input.localWorktreeId,
              labels: {
                [MIRROR_LABEL_LOCAL_WORKTREE]: input.localWorktreeId,
                [MIRROR_LABEL_MODE]: transferModeFor(token),
              },
              ignores: input.ignores,
              ...(input.direction === "push"
                ? { push: true }
                : input.direction === "replica"
                  ? { replica: true }
                  : { pull: true }),
            }),
          ),
          (session) => waitSettled(daemon, session, onProgress),
          (session) =>
            daemon
              .terminate(session)
              .pipe(
                Effect.catch((error) =>
                  Effect.sync(() =>
                    log.warn(
                      `[sync] could not end the file transfer session: ${errorWordsOf(error)}`,
                    ),
                  ),
                ),
              ),
        );
      }).pipe(
        Effect.catch((error) => Effect.succeed(failed(errorWordsOf(error)))),
      ),
    (token) => Effect.sync(() => endTransfer(token)),
  );

// One full cycle with both sides scanned and nothing left staging is
// the files across. Staging figures feed the progress bar.
function settled(raw: MirrorSessionRaw): boolean {
  return (
    raw.status === "watching" &&
    raw.successfulCycles >= 1 &&
    raw.local.scanned &&
    raw.remote.scanned &&
    raw.local.staging === undefined &&
    raw.remote.staging === undefined
  );
}

const waitSettled = (
  daemon: MirrorEngine["Service"],
  session: string,
  onProgress: (bytes: number, totalBytes: number) => void,
) =>
  Effect.gen(function* () {
    // Elapsed time: a sleep or a clock step spends none of a ceiling.
    const clock = yield* Clock.Clock;
    const now = () => elapsedMillisUnsafe(clock);
    const startedAt = now();
    let missingSince: number | null = null;
    let reportedBytes = -1;
    // When a side that had connected stopped being connected, so a
    // peer lost mid-transfer (its session closed under a sign-out or
    // a revoke, on either end) fails at the connect ceiling like a
    // peer never reached, instead of polling out the settle ceiling.
    let disconnectedSince: number | null = null;
    let everConnected = false;
    while (now() - startedAt < SETTLE_CEILING_MS) {
      const raw =
        (yield* daemon.status) === "running"
          ? yield* findSession(daemon, session)
          : undefined;
      if (raw === undefined) {
        missingSince ??= now();
        if (now() - missingSince > MISSING_CEILING_MS) {
          return failed("the transfer session was lost with the engine");
        }
      } else {
        missingSince = null;
        const staging = raw.local.staging ?? raw.remote.staging;
        // A frame only when the figure moved: a stalled stage is not
        // news four times a second.
        if (staging !== undefined && staging.receivedSize !== reportedBytes) {
          reportedBytes = staging.receivedSize;
          onProgress(staging.receivedSize, staging.expectedSize);
        }
        if (isHaltedStatus(raw.status)) {
          return failed(raw.lastError ?? raw.statusText);
        }
        // No cycle yet after the connect ceiling, and either an error
        // or a side still not connected (a source that went away, which
        // reports no error at all): the session is not going to.
        const connected = raw.local.connected && raw.remote.connected;
        if (
          raw.successfulCycles === 0 &&
          now() - startedAt > CONNECT_CEILING_MS &&
          (raw.lastError !== undefined || !connected)
        ) {
          return failed(
            raw.lastError ?? "the other device could not be reached",
          );
        }
        if (connected) {
          everConnected = true;
          disconnectedSince = null;
        } else if (everConnected) {
          disconnectedSince ??= now();
          if (now() - disconnectedSince > CONNECT_CEILING_MS) {
            return failed(
              raw.lastError ?? "the other device went away mid-transfer",
            );
          }
        }
        if (settled(raw)) {
          return { crossed: true, conflicts: raw.conflicts.length };
        }
      }
      // A poll, by design.
      yield* Effect.sleep(POLL_MS);
    }
    // What the session says now decides, not the ceiling alone.
    const last = yield* findSession(daemon, session);
    if (last !== undefined && settled(last)) {
      return { crossed: true, conflicts: last.conflicts.length };
    }
    return failed("the transfer did not settle in time");
  });
