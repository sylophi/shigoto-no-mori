// A transplant's file carrier: the mirror engine, run once. The pull
// has landed the branch and the capture through git. What git never
// carries (the ignored files the leave-out rule admits) crosses here,
// as one session between the new worktree and the source, held until
// its first full cycle has settled, then ended. A send runs the same
// session the other way: this device holds the source and pushes to
// the worktree the peer just created. Labelled a transfer so
// nothing that lists, follows or narrates mirrors sees it
// (registry.ts mirrorSessions). Nothing here fails the pull: the
// worktree is real either way, and the outcome (crossed, with how
// many conflicts, or why not) rides the pull's result.
import { Clock, Effect, Option, Schedule } from "effect";
import { errorMessageOf } from "@shared/errors";
import {
  isHaltedStatus,
  MIRROR_LABEL_TRANSFER,
} from "@shared/ipc/modules/mirror";
import { hostAttempt, hostRuntime } from "@host/runtime";
import {
  beginTransfer,
  endTransfer,
  findSession,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorEngine,
  type MirrorImpl,
  type MirrorSessionRaw,
  runningEngine,
} from "./registry";

export type TransferFilesResult = {
  crossed: boolean;
  // Paths both sides held with different content when the session
  // opened (a setup script's output against the source's, say). The
  // engine leaves both alone, so the copy here keeps its own version.
  conflicts: number;
  error?: string;
};

const POLL = "250 millis";
// The daemon reports no sessions while it restarts and the same ones
// come back moments later. A session gone for longer was lost with it.
const MISSING_CEILING = "10 seconds";
// An error with no cycle behind it for this long is a session that
// cannot connect (the peer's engine, the grant), not a slow one.
const CONNECT_CEILING_MS = 60_000;
// A whole node_modules over a slow link takes as long as it takes. The
// ceiling is for a session that never settles.
const SETTLE_CEILING = "30 minutes";

function failed(error: string): TransferFilesResult {
  return { crossed: false, conflicts: 0, error };
}

export type TransferFilesInput = {
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
  direction?: "pull" | "push";
};

// The transfer as an Effect: never failing (the outcome is the
// result), and interruptible while it waits. A caller that leaves
// stops the polling at once, and the session is ended on the way out
// like a settled one: the transfer's token and its session are
// resources of this fiber.
export const transferFiles = (
  input: TransferFilesInput,
  onProgress: (bytes: number, totalBytes: number) => void,
): Effect.Effect<TransferFilesResult, never, MirrorEngine> =>
  Effect.scoped(
    Effect.gen(function* () {
      // Released last, after the terminate, so main's sweep only picks
      // the session up when that failed, or when the create was
      // rejected with the session already made and there was no id to
      // terminate.
      const token = yield* Effect.acquireRelease(
        Effect.sync(beginTransfer),
        (live) => Effect.sync(() => endTransfer(live)),
      );
      const daemon = yield* runningEngine;
      const session = yield* Effect.acquireRelease(
        hostAttempt(() =>
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
              [MIRROR_LABEL_TRANSFER]: token,
            },
            ignores: input.ignores,
            ...(input.direction === "push" ? { push: true } : { pull: true }),
          }),
        ),
        (made) =>
          Effect.promise(() =>
            daemon.terminate(made).catch((error: unknown) => {
              console.warn(
                `[sync] could not end the file transfer session: ${errorMessageOf(error)}`,
              );
            }),
          ),
      );
      return yield* waitSettled(daemon, session, onProgress);
    }),
  ).pipe(
    Effect.catch((error) => Effect.succeed(failed(errorMessageOf(error)))),
  );

// The same transfer for a Promise-side caller, on the host's runtime.
export function transferFilesOnce(
  input: TransferFilesInput,
  onProgress: (bytes: number, totalBytes: number) => void,
): Promise<TransferFilesResult> {
  return hostRuntime().runPromise(transferFiles(input, onProgress));
}

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

// Polls the daemon's session every POLL until it settled or failed, as
// an `Effect.repeat` on a spaced schedule, so the wait is a sleep a
// caller that leaves interrupts. Each ceiling is its own bound: the
// settle ceiling is a timeout over the whole wait, and the missing one
// a timeout over the wait for a session the daemon stopped listing to
// come back. The connect ceiling is not a plain deadline (a session
// still scanning with both sides connected is slow, not stuck, and a
// side that reconnects resets it), so it is read off the clock inside
// the poll.
const waitSettled = (
  daemon: MirrorImpl,
  session: string,
  onProgress: (bytes: number, totalBytes: number) => void,
): Effect.Effect<TransferFilesResult> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let reportedBytes = -1;
    // When a side that had connected stopped being connected, so a
    // peer lost mid-transfer (its session closed under a sign-out or
    // a revoke, on either end) fails at the connect ceiling like a
    // peer never reached, instead of polling out the settle ceiling.
    let disconnectedSince: number | null = null;
    let everConnected = false;
    const lookUp = Effect.sync(() => findSession(daemon, session));
    // A session the daemon stopped listing, given the missing ceiling
    // to come back.
    const reappeared = lookUp.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(POLL),
        until: (raw) => raw !== undefined,
      }),
      Effect.timeoutOption(MISSING_CEILING),
    );
    // One look: the outcome once there is one.
    const poll: Effect.Effect<Option.Option<TransferFilesResult>> = Effect.gen(
      function* () {
        let raw = yield* lookUp;
        if (raw === undefined) {
          const back = yield* reappeared;
          if (Option.isNone(back) || back.value === undefined) {
            return Option.some(
              failed("the transfer session was lost with the engine"),
            );
          }
          raw = back.value;
        }
        const now = yield* Clock.currentTimeMillis;
        const staging = raw.local.staging ?? raw.remote.staging;
        // A frame only when the figure moved: a stalled stage is not
        // news four times a second.
        if (staging !== undefined && staging.receivedSize !== reportedBytes) {
          reportedBytes = staging.receivedSize;
          onProgress(staging.receivedSize, staging.expectedSize);
        }
        if (isHaltedStatus(raw.status)) {
          return Option.some(failed(raw.lastError ?? raw.statusText));
        }
        // No cycle yet after the connect ceiling, and either an error
        // or a side still not connected (a source that went away, which
        // reports no error at all): the session is not going to.
        const connected = raw.local.connected && raw.remote.connected;
        if (
          raw.successfulCycles === 0 &&
          now - startedAt > CONNECT_CEILING_MS &&
          (raw.lastError !== undefined || !connected)
        ) {
          return Option.some(
            failed(raw.lastError ?? "the other device could not be reached"),
          );
        }
        if (connected) {
          everConnected = true;
          disconnectedSince = null;
        } else if (everConnected) {
          disconnectedSince ??= now;
          if (now - disconnectedSince > CONNECT_CEILING_MS) {
            return Option.some(
              failed(
                raw.lastError ?? "the other device went away mid-transfer",
              ),
            );
          }
        }
        if (settled(raw)) {
          return Option.some({
            crossed: true,
            conflicts: raw.conflicts.length,
          });
        }
        return Option.none();
      },
    );
    return yield* poll.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(POLL),
        until: Option.isSome<TransferFilesResult>,
      }),
      Effect.map((outcome) => outcome.value),
      Effect.timeoutOrElse({
        duration: SETTLE_CEILING,
        orElse: () =>
          Effect.succeed(failed("the transfer did not settle in time")),
      }),
    );
  });
