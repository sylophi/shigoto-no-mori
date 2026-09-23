// Host side of continuous worktree mirroring (shared/ipc/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/core/mirror/daemon.ts, spawned and supervised there), so it arrives
// as a service main provides (MirrorEngine, host/mirror/registry.ts),
// beside the PortForwardEngine precedent. This module owns the rest: the start orchestration, the
// stream open a peer drives to mirror FROM here (with the serving
// registry and the served index watcher behind it), and the git half
// a peer's follower reads and applies.
//
// start = pull, then mirror. The pull (sync:pullWorktree's
// orchestration, reused verbatim) lands the peer's branch, commits and
// uncommitted changes as a new local worktree through the ordinary
// create, so carry-over (and setup, when the dialog asked for it) ride
// along and git agrees on both sides before a single file is watched. The mirror session then opens
// between that worktree and the peer's, with almost nothing left to
// move. The peer's root path is read off its own worktree list over
// the grant-gated wire, never taken from the caller.
//
// Every handler is an Effect run under its caller's signal
// (hostHandler). The steps that must finish once begun are marked
// uninterruptible where they sit: a start's session open (or its
// rollback) once the pull landed, a stop's terminate and the copy's
// removal, a git state apply.
import { Cause, Context, Effect, Schema } from "effect";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_COPY_STAYED,
  MIRROR_STOP_UNCONFIRMED,
  mirrorCopyIsRemote,
  type MirrorGitStatus,
  type MirrorListResult,
  type MirrorServing,
  type MirrorSession,
  MirrorSessionSchema,
  type MirrorStartPayloadSchema,
  type MirrorStartToPayloadSchema,
  mirrorContract,
  mirrorStopIsSafe,
  summarizeIgnores,
} from "@shared/ipc/modules/mirror";
import { DeleteWorktreeResultSchema, type Worktree } from "@shared/schemas";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf, unknownWorktreeError } from "@shared/errors";
import { spawnFileSync } from "@host/fileSync/spawn";
import { peerApis, peerWorktree } from "@host/ipc/peerSync";
import { deleteAnyLocalBranch } from "@host/lib/git/branches";
import {
  findWorktreeIdentityOrThrow,
  removeWorktreeForce,
  worktreeIdFromPath,
  type WorktreeIdentity,
} from "@host/lib/git/worktrees";
import { findProjectOrThrow } from "@host/lib/projects";
import { dropWorktreeMarks } from "@host/lib/worktrees/marks";
import {
  applyGitState,
  readGitState,
  watchIndexFile,
} from "@host/mirror/gitState";
import {
  engineOrNull,
  findSession,
  ignoreModeOf,
  localWorktreeIdOf,
  MIRROR_LABEL_IGNORE_MODE,
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorImpl,
  type MirrorSessionRaw,
  mirrorEngine,
  mirrorSessions,
  runningEngine,
} from "@host/mirror/registry";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { hostAttempt, hostHandler, hostServiceOrNull } from "@host/runtime";
import { runPullWorktree, sendWorktree } from "./sync";
import { worktreesHandlers } from "./worktrees";

// The daemon service, the session labels and the raw session shapes live
// in host/mirror/registry.ts, where the worktree delete can reach them
// without importing this module (which reaches sync, which reaches
// worktrees). Re-exported so the daemon and the follower keep one
// import path.
export {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  MirrorEngine,
  type MirrorCreateInput,
  type MirrorImpl,
  type MirrorSessionRaw,
} from "@host/mirror/registry";

// The mirror streams this host currently serves, keyed by the calling
// device and the channel id it minted (unique per connection, so the
// pair is what identifies a stream host-wide): what mirror:list
// reports as `serving`, so a worktree shows "mirrored to <device>" on
// the machine it lives on. Entries live exactly as long as their
// channel. Each carries the served worktree's index watcher: a stage
// or unstage there is the one git change the peer's follower cannot
// learn from the git-directory watcher.
type Served = { entry: MirrorServing; stopIndexWatch: (() => void) | null };
const serving = new Map<string, Served>();

// main provides the two broadcast hooks. On a runtime without them (a
// check that never mounts them) changes are simply unannounced.
export class MirrorServingListener extends Context.Service<
  MirrorServingListener,
  () => void
>()("sm/host/MirrorServingListener") {}

export class MirrorGitChangedListener extends Context.Service<
  MirrorGitChangedListener,
  (change: { projectId: string; worktreeId: string }) => void
>()("sm/host/MirrorGitChangedListener") {}

const onServingChange = () => hostServiceOrNull(MirrorServingListener);
const onServingGitChange = () => hostServiceOrNull(MirrorGitChangedListener);

export function listMirrorServing(): MirrorServing[] {
  return [...serving.values()].map((served) => served.entry);
}

function servingKey(ctx: HandlerContext, channelId: string): string {
  return `${ctx.callerDeviceId ?? ""}:${channelId}`;
}

function forgetServing(key: string): void {
  const served = serving.get(key);
  if (served === undefined) return;
  served.stopIndexWatch?.();
  serving.delete(key);
  onServingChange()?.();
}

// The daemon's document with the two label-borne ids lifted to fields,
// validated against the contract so a daemon/app drift fails here
// with a schema error instead of as undefined in the renderer.
function annotateMirrorSession(
  raw: MirrorSessionRaw,
  git?: MirrorGitStatus,
): MirrorSession {
  return Schema.decodeUnknownSync(MirrorSessionSchema)({
    ...raw,
    localProjectId: raw.labels[MIRROR_LABEL_LOCAL_PROJECT] ?? "",
    localWorktreeId: raw.labels[MIRROR_LABEL_LOCAL_WORKTREE] ?? "",
    ignoreMode: ignoreModeOf(raw.labels),
    ...(git === undefined ? {} : { git }),
  });
}

async function rollBackPull(worktree: {
  projectId: string;
  path: string;
  branch: string;
}): Promise<void> {
  const project = findProjectOrThrow(worktree.projectId);
  await removeWorktreeForce(project.path, worktree.path);
  // The create ran through the CLI, which may have seeded an auto-pull
  // mark (autoPullNew). This removal does not, so retire it here.
  dropWorktreeMarks(worktreeIdFromPath(worktree.path));
  await deleteAnyLocalBranch(project.path, worktree.branch, true);
}

// A device's mirror picture: what mirror:list answers and what
// mirror:changed carries. The same for every caller.
function mirrorListOf(daemon: MirrorImpl): MirrorListResult {
  return {
    daemon: daemon.status(),
    sessions: mirrorSessions(daemon).map((raw) =>
      annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
    ),
    serving: listMirrorServing(),
  };
}

// The list for the changed broadcast, or undefined, which a reader
// answers by asking. Before the daemon is wired there is none to send.
// A list that fails to build is said so: this runs off a timer, where
// a throw would be the main process's uncaught exception.
export function currentMirrorList(): MirrorListResult | undefined {
  const daemon = engineOrNull();
  if (daemon === null) return undefined;
  try {
    return mirrorListOf(daemon);
  } catch (error) {
    console.warn(
      `[mirror] the changed broadcast goes without its list: ${errorMessageOf(error)}`,
    );
    return undefined;
  }
}

// The same context with a signal that never aborts, for a handler of
// another module called from inside an uninterruptible step: that
// handler runs under its own caller's signal, and a step that must
// finish must not have it refuse to start because the caller left.
const detached = (ctx: HandlerContext): HandlerContext => ({
  ...ctx,
  signal: new AbortController().signal,
});

// mirror:list, for the control ops too.
export const mirrorList = Effect.flatMap(mirrorEngine, (daemon) =>
  hostAttempt(() => mirrorListOf(daemon)),
);

// The rollback of a start whose session did not open, and the note of
// one that did. No session, so no copy either: the pull (or the send)
// is undone, or a retry would refuse on the branch the failed attempt
// left behind. Best effort. A rollback failure is logged, not thrown
// over the real error.
const openSession = <A>(
  create: Effect.Effect<string, unknown>,
  rollBack: () => Promise<unknown>,
  what: string,
  started: (session: string) => A,
) =>
  create.pipe(
    Effect.tapError(() =>
      Effect.promise(() =>
        rollBack().catch((rollbackError: unknown) => {
          console.warn(
            `[mirror] could not remove ${what} of a failed start: ${errorMessageOf(rollbackError)}`,
          );
        }),
      ),
    ),
    Effect.map(started),
  );

// A start whose caller left during the landing: the worktree (or the
// peer's copy) exists, so the start is carried to its end for them,
// the way the Promise this replaced ran to its end. Nothing can hear
// the answer, so a failure is logged; openSession has already rolled
// the copy back by then.
const finishAfterLeaving = (
  open: Effect.Effect<unknown, unknown>,
  what: string,
) =>
  open.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        console.warn(
          `[mirror] a start whose caller left could not open its session on ${what}: ${errorMessageOf(Cause.squash(cause))}`,
        );
      }),
    ),
  );

// mirror:start. Every precondition before the pull, so a refusal
// creates nothing: the engine must be up, and the peer's worktree must
// exist (its root path is read off the peer's own list, because it
// flows into a session this device persists). The branch collision is
// the pull's own guard. The pull is interruptible up to its landing
// (see runPullWorktree). From the landing on, nothing is: the session
// opens, or the pull is rolled back. A caller that leaves during the
// landing is the one case the mask alone does not cover (the pull's
// landing step finishes, then the pull ends as interrupted, and the
// session would never open), so the pull's `onLanded` hook keeps the
// landed worktree and the interrupt path opens the session for the
// caller that left. Either way: a mirror, or nothing, never a
// worktree the start left behind without its session.
export const startMirror = (
  input: typeof MirrorStartPayloadSchema.Type,
  ctx: HandlerContext,
) =>
  Effect.gen(function* () {
    const daemon = yield* runningEngine;
    const source = yield* peerWorktree(
      input.sourceDeviceId,
      input.sourceProjectId,
      input.sourceWorktreeId,
    );
    if (source === undefined) {
      return yield* Effect.fail(unknownWorktreeError(input.sourceWorktreeId));
    }
    const { ignoreMode, ignores, ...pullInput } = input;
    const open = (pulled: Worktree) =>
      openSession(
        hostAttempt(() =>
          daemon.create({
            localRoot: pulled.path,
            deviceId: input.sourceDeviceId,
            projectId: input.sourceProjectId,
            worktreeId: input.sourceWorktreeId,
            remoteRoot: source.path,
            name: input.branch,
            localWorktreeId: pulled.id,
            labels: {
              [MIRROR_LABEL_LOCAL_PROJECT]: pulled.projectId,
              [MIRROR_LABEL_LOCAL_WORKTREE]: pulled.id,
              [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
            },
            ignores,
          }),
        ),
        () => rollBackPull(pulled),
        "the worktree",
        (session) => {
          daemon.noteEvent(
            pulled.id,
            "started",
            summarizeIgnores(ignoreMode, ignores),
          );
          return session;
        },
      );
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let landed: Worktree | undefined;
        const pulled = yield* restore(
          runPullWorktree(pullInput, ctx, {
            onLanded: (worktree) => {
              landed = worktree;
            },
          }),
        ).pipe(
          Effect.onInterrupt(() =>
            landed === undefined
              ? Effect.void
              : finishAfterLeaving(open(landed), "the worktree"),
          ),
        );
        const session = yield* open(pulled.worktree);
        return { ...pulled, session };
      }),
    );
  });

// mirror:startTo. The mirror turned around: one of this device's
// worktrees, sent to a peer and kept in step with the copy made there.
// The session runs here all the same (this device holds the original,
// the peer the copy, and the label says so for the stop), so like the
// send it rides the peer's grant alone. No leave-out rule goes to the
// send: the session opened next carries the ignored files and keeps
// carrying them, as in start. Interruptible up to the peer's landing,
// then not, for start's reason, with the same hook for a caller that
// leaves while the peer makes the copy.
export const startMirrorTo = (
  input: typeof MirrorStartToPayloadSchema.Type,
  ctx: HandlerContext,
) =>
  Effect.gen(function* () {
    const daemon = yield* runningEngine;
    const apis = yield* peerApis;
    const { ignoreMode, ignores, ...sendInput } = input;
    const open = (copy: Worktree, source: WorktreeIdentity) =>
      openSession(
        hostAttempt(() =>
          daemon.create({
            localRoot: source.path,
            deviceId: input.targetDeviceId,
            projectId: copy.projectId,
            worktreeId: copy.id,
            // The copy's root as the peer's landing answered it,
            // re-parsed by the send.
            remoteRoot: copy.path,
            name: source.branch,
            localWorktreeId: source.id,
            labels: {
              [MIRROR_LABEL_LOCAL_PROJECT]: input.projectId,
              [MIRROR_LABEL_LOCAL_WORKTREE]: source.id,
              [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
              [MIRROR_LABEL_COPY_SIDE]: "remote",
            },
            ignores,
          }),
        ),
        () =>
          apis.worktreesApiFor(input.targetDeviceId).delete({
            projectId: copy.projectId,
            worktreeId: copy.id,
            force: true,
          }),
        "the peer's copy",
        (session) => {
          daemon.noteEvent(
            source.id,
            "started",
            summarizeIgnores(ignoreMode, ignores),
          );
          return session;
        },
      );
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let landed: { copy: Worktree; source: WorktreeIdentity } | undefined;
        const { source, result: sent } = yield* restore(
          sendWorktree(sendInput, ctx, {
            onLanded: (copy, from) => {
              landed = { copy, source: from };
            },
          }),
        ).pipe(
          Effect.onInterrupt(() =>
            landed === undefined
              ? Effect.void
              : finishAfterLeaving(
                  open(landed.copy, landed.source),
                  "the peer's copy",
                ),
          ),
        );
        const session = yield* open(sent.worktree, source);
        return { ...sent, session };
      }),
    );
  });

// mirror:stop ends the session and removes the copy the mirror made:
// the mirror was the copy's reason to exist, and the source keeps the
// branch. The copy is this device's worktree, or the peer's for a
// mirror started to it (startTo), where the original here stays. The
// delete follows the terminate (the other way round the tombstone
// protocol would stop the session itself, mid-delete) and is forced,
// since the copy carries the source's uncommitted state by design. A
// copy the delete cannot remove is reported with the session already
// gone: the worktree page then offers the ordinary delete. The guard
// is the only part a caller that leaves can stop: from the terminate
// on, the stop runs to its end (the session gone, the copy gone or
// reported on its thread), since a stop left halfway is a copy with no
// session and no line saying why.
export const stopMirror = (
  { session, force }: { session: string; force?: boolean | undefined },
  ctx: HandlerContext,
) =>
  Effect.gen(function* () {
    const daemon = yield* mirrorEngine;
    const raw = findSession(daemon, session);
    if (raw === undefined) {
      return yield* Effect.fail(new Error("That mirror is no longer running."));
    }
    // The copy goes with the stop. Refusing on "diverged" alone read
    // as safe exactly when it cannot know: a paused session reports
    // "off" and an unreachable peer "error", since divergence is
    // computed against a live peer. So anything but "synced" refuses.
    const git = daemon.gitStatus(session)?.status;
    if (force !== true && !mirrorStopIsSafe(git)) {
      return yield* Effect.fail(
        new Error(
          `${MIRROR_STOP_UNCONFIRMED} (${git ?? "starting"}), so it may hold commits that exist nowhere else. Resume or reconnect the mirror to let it catch up, or stop it anyway to discard them.`,
        ),
      );
    }
    const apis = yield* peerApis;
    return yield* Effect.uninterruptible(
      hostAttempt(async () => {
        await daemon.terminate(session);
        // How the copy goes depends on where it is. What follows does
        // not: a copy that stayed is reported, with the session already
        // gone.
        const localWorktreeId = localWorktreeIdOf(raw);
        const projectId = raw.labels[MIRROR_LABEL_LOCAL_PROJECT];
        const onPeer = mirrorCopyIsRemote(raw);
        let stayed: string | null;
        if (onPeer) {
          stayed = await apis
            .worktreesApiFor(raw.deviceId)
            .delete({
              projectId: raw.projectId,
              worktreeId: raw.worktreeId,
              force: true,
            })
            .then((result) => {
              const removed = Schema.decodeUnknownSync(
                DeleteWorktreeResultSchema,
              )(result);
              return removed.ok
                ? null
                : `its ${removed.cleanupError.phase} step failed`;
            }, errorMessageOf);
        } else if (localWorktreeId === "" || projectId === undefined) {
          stayed = "the session did not name its worktree";
        } else {
          // The ordinary delete, which takes the worktree's history
          // thread with it: there is no page left to show a "stopped"
          // line on.
          const removed = await worktreesHandlers.delete(
            { projectId, worktreeId: localWorktreeId, force: true },
            detached(ctx),
          );
          stayed = removed.ok
            ? null
            : `its ${removed.cleanupError.phase} step failed`;
        }
        // A copy on the peer leaves the page this was stopped from
        // standing, so its thread gets the line either way.
        if (stayed !== null || onPeer) {
          daemon.noteEvent(
            localWorktreeId,
            "stopped",
            stayed === null
              ? ""
              : `Copy on ${onPeer ? "the other" : "this"} device kept`,
          );
        }
        if (stayed !== null) {
          throw new Error(
            `${MIRROR_COPY_STAYED} ${onPeer ? "on the other device" : "here"} stayed: ${stayed}. Delete it from its page.`,
          );
        }
      }),
    );
  });

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: hostHandler(() => mirrorList),

  start: hostHandler((input, ctx: HandlerContext) => startMirror(input, ctx)),

  startTo: hostHandler((input, ctx: HandlerContext) =>
    startMirrorTo(input, ctx),
  ),

  stop: hostHandler((input, ctx: HandlerContext) =>
    stopMirror(input, ctx).pipe(Effect.as(undefined)),
  ),

  // The engine's change and the thread's line about it are one step:
  // a caller leaving between the two would leave a paused session
  // whose thread never says so.
  pause: hostHandler(({ session }) =>
    Effect.gen(function* () {
      const daemon = yield* mirrorEngine;
      yield* Effect.uninterruptible(
        hostAttempt(async () => {
          await daemon.pause(session);
          daemon.noteEvent(
            localWorktreeIdOf(findSession(daemon, session)),
            "paused",
            "",
          );
        }),
      );
      return undefined;
    }),
  ),

  resume: hostHandler(({ session }) =>
    Effect.gen(function* () {
      const daemon = yield* mirrorEngine;
      yield* Effect.uninterruptible(
        hostAttempt(async () => {
          await daemon.resume(session);
          daemon.noteEvent(
            localWorktreeIdOf(findSession(daemon, session)),
            "resumed",
            "",
          );
        }),
      );
      return undefined;
    }),
  ),

  // The engine cannot re-configure a live session, so a change of
  // ignores re-opens it on the same pair (MirrorImpl.recreate, which
  // keeps the old one until the new one is up and carries the git
  // follower's agreement across), the labels carried over. The pair's
  // files are already in agreement, so the new session's first cycle
  // has little to do. Uninterruptible once asked: the recreate swaps
  // the session under the same pair, and its answer is the only place
  // the new id and the thread's line come from.
  setIgnores: hostHandler(({ session, ignoreMode, ignores }) =>
    Effect.gen(function* () {
      const daemon = yield* mirrorEngine;
      const raw = findSession(daemon, session);
      if (raw === undefined) {
        return yield* Effect.fail(
          new Error("That mirror is no longer running."),
        );
      }
      const localWorktreeId = localWorktreeIdOf(raw);
      const next = yield* Effect.uninterruptible(
        hostAttempt(async () => {
          const recreated = await daemon.recreate(session, {
            localRoot: raw.localRoot,
            deviceId: raw.deviceId,
            projectId: raw.projectId,
            worktreeId: raw.worktreeId,
            remoteRoot: raw.remoteRoot,
            name: raw.name,
            localWorktreeId,
            labels: { ...raw.labels, [MIRROR_LABEL_IGNORE_MODE]: ignoreMode },
            ignores,
          });
          daemon.noteEvent(
            localWorktreeId,
            "ignores-changed",
            summarizeIgnores(ignoreMode, ignores),
          );
          return recreated;
        }),
      );
      return { session: next };
    }),
  ),

  history: hostHandler(({ localWorktreeId }) =>
    Effect.map(mirrorEngine, (daemon) => ({
      events: daemon.history(localWorktreeId),
    })),
  ),

  // A mirror stream: the far end is a fresh `file-sync serve` for the
  // named worktree, spoken to over its stdio. The worktree must exist
  // in this host's registry (a peer can only mirror what this device
  // lists), and the child dies with the channel: a peer reset, an end
  // from both sides or the socket dying all kill it, and a child that
  // exits on its own ends the channel the ordinary way. The root path
  // the peer's Mutagen side names travels inside the protocol, which
  // this handler does not read: the grant is the wall, as everywhere
  // on the byte-stream surface. Interruptible only up to the lookup:
  // from the spawn to the attach nothing yields, so a child is never
  // left without the channel that ends it.
  openStream: hostHandler(
    (
      { projectId, worktreeId, channelId, peerWorktreeId },
      ctx: HandlerContext,
    ) =>
      Effect.gen(function* () {
        const identity = yield* hostAttempt(async () => {
          requireChannels(ctx, channelId);
          const project = findProjectOrThrow(projectId);
          return findWorktreeIdentityOrThrow(
            projectId,
            project.path,
            worktreeId,
          );
        });
        yield* hostAttempt(() =>
          serveStream(ctx, identity.path, {
            projectId,
            worktreeId,
            channelId,
            peerWorktreeId,
          }),
        );
        return undefined;
      }),
  ),

  // The git half served to the device mirroring from here (see
  // host/mirror/gitState.ts): the worktree must be one this host
  // lists, and the state is read or applied in place.
  gitState: hostHandler(({ projectId, worktreeId }) =>
    hostAttempt(async () => {
      const project = findProjectOrThrow(projectId);
      const identity = await findWorktreeIdentityOrThrow(
        projectId,
        project.path,
        worktreeId,
      );
      return readGitState(project.path, identity.path, worktreeId);
    }),
  ),

  // Uninterruptible once the worktree is found: the apply moves the
  // branch, HEAD and the index in turn, and a caller that leaves must
  // not see it stop between them (the compare-and-set that guards it
  // is only checked at its start).
  applyGitState: hostHandler(
    ({ projectId, worktreeId, expect, state, sweep }) =>
      Effect.gen(function* () {
        const { project, identity } = yield* hostAttempt(async () => {
          const found = findProjectOrThrow(projectId);
          return {
            project: found,
            identity: await findWorktreeIdentityOrThrow(
              projectId,
              found.path,
              worktreeId,
            ),
          };
        });
        const result = yield* Effect.uninterruptible(
          hostAttempt(() =>
            applyGitState(
              project,
              { id: worktreeId, path: identity.path },
              { expect, state, sweep },
            ),
          ),
        );
        return result.applied
          ? { applied: true }
          : { applied: false, reason: result.reason };
      }),
  ),
};

// The serve child for a stream, attached to the caller's channel. All
// synchronous from the spawn to the attach, so nothing can interrupt
// between them.
function serveStream(
  ctx: HandlerContext,
  worktreePath: string,
  {
    projectId,
    worktreeId,
    channelId,
    peerWorktreeId,
  }: Pick<
    MirrorServing,
    "projectId" | "worktreeId" | "channelId" | "peerWorktreeId"
  >,
): void {
  const child = spawnFileSync(["serve"]);
  if (child === null) {
    throw new Error(
      "mirroring is unavailable on this device (no file-sync engine)",
    );
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text !== "") console.warn(`[mirror] serve ${worktreeId}: ${text}`);
  });
  const key = servingKey(ctx, channelId);
  const stopChild = () => {
    child.kill();
    child.stream.destroy();
  };
  try {
    attachFarEnd(ctx, channelId, child.stream, {
      onClosed: () => {
        stopChild();
        forgetServing(key);
      },
    });
  } catch (error) {
    // The connection died or the id was claimed during the lookup
    // above: the child is detached, so the destroyed stdio alone
    // would not end it.
    stopChild();
    throw error;
  }
  const served: Served = {
    entry: {
      channelId,
      projectId,
      worktreeId,
      peerDeviceId: ctx.callerDeviceId ?? "",
      ...(peerWorktreeId === undefined ? {} : { peerWorktreeId }),
      since: Date.now(),
    },
    stopIndexWatch: null,
  };
  serving.set(key, served);
  void watchIndexFile(worktreePath, () =>
    onServingGitChange()?.({ projectId, worktreeId }),
  ).then(
    (stop) => {
      if (serving.get(key) === served) served.stopIndexWatch = stop;
      else stop();
    },
    () => {},
  );
  onServingChange()?.();
}
