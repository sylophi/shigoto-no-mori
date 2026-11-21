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
import { messageOf } from "@shigomori/engine/errorDocument";
import {
  anchorIgnoredPath,
  broughtPaths,
  onlyIgnores,
  unanchorIgnoredPath,
} from "@shigomori/contracts/mirrorIgnores";
import type { MirrorIgnoreMode } from "@shigomori/contracts/modules/sync";
import {
  isHaltedStatus,
  MIRROR_LABEL_MODE,
  MIRROR_STATUS_WORDS,
  mirrorProblemCount,
} from "@shigomori/contracts/modules/mirror";
import {
  isSameOrInside,
  trimTrailingSlashes,
} from "@shigomori/contracts/projectPaths";
import type { FilesBrought } from "@shigomori/contracts/schemas";
import { listed, pluralize } from "@shigomori/contracts/words";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  findSession,
  transferModeFor,
  type MirrorSessionRaw,
  requireRunningEngine,
} from "./registry";
import type { MirrorEngine } from "./MirrorEngine";
import { MirrorLedger } from "./MirrorLedger";
import { elapsedMillisUnsafe } from "@shigomori/engine/elapsed";
import { log } from "@shared/log";

type Direction = "pull" | "push" | "replica";

const POLL_MS = 250;
// The daemon's snapshots trail its answers (file-sync/engine.go
// throttles them), so a session its create just made can be missing
// from the last one, and a daemon that isn't running lists the sessions
// it had, which nothing carries. Missing, or with no daemon running, for
// longer than this, the transfer is lost.
const MISSING_CEILING_MS = 10_000;
// Not connected for this long is a session that cannot connect (the
// peer's engine, the grant), not a slow one.
const CONNECT_CEILING_MS = 60_000;
// A whole node_modules over a slow link takes as long as it takes. The
// ceiling is for a session that never settles.
const SETTLE_CEILING_MS = 30 * 60_000;

function failed(error: string, conflicts = 0): FilesBrought {
  return { crossed: false, conflicts, error };
}

// An interrupt (the move's cancel) ends the session where it stands, a
// create the cancel outran included (the host's sweep is the backstop, by
// the token). The caller decides what becomes of the worktree.
export const transferFilesOnce = (
  {
    direction = "pull",
    ...input
  }: {
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
    direction?: Direction;
  },
  onProgress: (bytes: number, totalBytes: number) => void,
): Effect.Effect<FilesBrought, never, MirrorEngine | MirrorLedger> =>
  Effect.flatMap(MirrorLedger, (ledger) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        ledger.beginTransfer({
          deviceId: input.sourceDeviceId,
          worktreeId: input.sourceWorktreeId,
          transfer: direction === "pull" ? "out" : "in",
        }),
      ),
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
                labels: { [MIRROR_LABEL_MODE]: transferModeFor(token) },
                ignores: input.ignores,
                direction,
              }),
            ),
            (session) => waitSettled(daemon, session, direction, onProgress),
            (session) =>
              daemon
                .terminate(session)
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      log.warn(
                        `[sync] could not end the file transfer session: ${messageOf(error)}`,
                      ),
                    ),
                  ),
                ),
          );
        }).pipe(
          Effect.catch((error) => Effect.succeed(failed(messageOf(error)))),
        ),
      (token) => Effect.sync(() => ledger.endTransfer(token)),
    ),
  );

// A move's files step: the source's ignored paths the leave-out rule
// admits, and nothing else. Tracked files are git's, and a pass over
// the whole worktree counts each one the two checkouts write
// differently (line endings, Windows against the rest) as a conflict.
// The paths past the engine's cap on patterns stay on the source, and
// the outcome says so, so a teardown keeps it. So does a repository
// nested in the paths it carries: the engine never copies a .git, so
// its history would go with the source.
export const carryIgnoredOnce = <R>(
  {
    ignoreMode,
    ignores,
    ignoredPaths,
    ignoredRepos,
    ...input
  }: Omit<Parameters<typeof transferFilesOnce>[0], "ignores"> & {
    direction: "pull" | "push";
    ignoreMode: MirrorIgnoreMode;
    ignores: readonly string[];
    // The source's topmost ignored paths (Git.listIgnoredPaths).
    ignoredPaths: Effect.Effect<readonly string[], unknown, R>;
    // The repositories nested in them (Git.listIgnoredRepos).
    ignoredRepos: Effect.Effect<readonly string[], unknown, R>;
  },
  onProgress: (bytes: number, totalBytes: number) => void,
) =>
  Effect.gen(function* () {
    // Any other rule's ignores are the paths it leaves out, kept last
    // too for one inside a folder git lists whole.
    const leftOut = ignores.map(unanchorIgnoredPath);
    const paths =
      ignoreMode === "bring"
        ? broughtPaths(ignores)
        : (yield* ignoredPaths).filter((path) => {
            const bare = path.replace(/\/+$/, "");
            return !leftOut.some(
              (left) => bare === left || bare.startsWith(`${left}/`),
            );
          });
    const carry = onlyIgnores(paths);
    const left = paths.filter(
      (path) => !carry.includes(`!${anchorIgnoredPath(path)}/**`),
    ).length;
    const files = yield* transferFilesOnce(
      {
        ...input,
        ignores: ignoreMode === "bring" ? carry : [...carry, ...ignores],
      },
      onProgress,
    );
    if (!files.crossed) return files;
    if (left > 0) {
      return failed(
        `${pluralize(left, "ignored path")} didn't fit in one pass`,
        files.conflicts,
      );
    }
    const repos = (yield* ignoredRepos)
      .filter((repo) => paths.some((path) => isSameOrInside(repo, path)))
      .map(trimTrailingSlashes);
    if (repos.length > 0) {
      return failed(
        `the git history of ${listed(repos)} isn't copied`,
        files.conflicts,
      );
    }
    return files;
  }).pipe(Effect.catch((error) => Effect.succeed(failed(messageOf(error)))));

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

// A file one side couldn't write or read never crossed, so a move's
// source still holds the only one. A replica is a mirror's first pass,
// and the mirror goes on to show its problems.
function outcome(raw: MirrorSessionRaw, direction: Direction): FilesBrought {
  const count = mirrorProblemCount(raw.local, raw.remote);
  if (direction === "replica" || count === 0) {
    return { crossed: true, conflicts: raw.conflicts.length };
  }
  const paths = [...raw.local.problems, ...raw.remote.problems]
    .slice(0, 3)
    .map((problem) => problem.path);
  const more = count - paths.length;
  return failed(
    `${pluralize(count, "file")} couldn't be copied (${listed(more > 0 ? [...paths, `${more} more`] : paths)})`,
    raw.conflicts.length,
  );
}

const waitSettled = (
  daemon: MirrorEngine["Service"],
  session: string,
  direction: Direction,
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
    // peer never reached, instead of polling out the settle ceiling,
    // and a link that drops once has that long to come back.
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
          return failed(raw.lastError ?? MIRROR_STATUS_WORDS[raw.status]);
        }
        const connected = raw.local.connected && raw.remote.connected;
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
        // Never connected by the connect ceiling (a source that went
        // away reports no error at all): the session is not going to.
        if (!everConnected && now() - startedAt > CONNECT_CEILING_MS) {
          return failed(
            raw.lastError ?? "the other device could not be reached",
          );
        }
        if (settled(raw)) return outcome(raw, direction);
      }
      // A poll, by design.
      yield* Effect.sleep(POLL_MS);
    }
    // What the session says now decides, not the ceiling alone.
    const last = yield* findSession(daemon, session);
    if (last !== undefined && settled(last)) return outcome(last, direction);
    return failed("the transfer did not settle in time");
  });
