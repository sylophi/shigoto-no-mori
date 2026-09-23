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
// (hostHandler). The steps that must finish once begun run as one
// uninterruptible step: a start's session open (or its rollback)
// inside the pull's landing, a stop's terminate and the copy's
// removal. A step that is a single hostAttempt (a pause, a git state
// apply) needs no marker: a caller that leaves stops the wait, never
// the work.
import { Context, Effect, Schema } from "effect";
import {
  MIRROR_LABEL_COPY_SIDE,
  mirrorCopyIsRemote,
  type MirrorGitStatus,
  type MirrorListResult,
  type MirrorServing,
  type MirrorSession,
  MirrorSessionSchema,
  type MirrorStartPayloadSchema,
  type MirrorStartToPayloadSchema,
  mirrorContract,
  type MirrorIgnoreMode,
  mirrorStopIsSafe,
  summarizeIgnores,
} from "@shared/ipc/modules/mirror";
import { DeleteWorktreeResultSchema } from "@shared/schemas";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  errorMessageOf,
  MirrorCopyStayed,
  MirrorStopUnconfirmed,
  unknownWorktreeError,
} from "@shared/errors";
import { spawnFileSync } from "@host/fileSync/spawn";
import { peerApis, peerWorktree } from "@host/ipc/peerSync";
import { deleteAnyLocalBranch } from "@host/lib/git/branches";
import {
  findWorktreeIdentityOrThrow,
  removeWorktreeForce,
  worktreeIdFromPath,
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
  type MirrorCreateInput,
  type MirrorImpl,
  type MirrorSessionRaw,
  mirrorEngine,
  mirrorSessions,
  runningEngine,
} from "@host/mirror/registry";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { hostAttempt, hostHandler, hostServiceOrNull } from "@host/runtime";
import { pullWorktreeThen, sendWorktreeThen } from "./sync";
import { deleteWorktree } from "./worktrees";

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

// mirror:list, for the control ops too.
export const mirrorList = Effect.flatMap(mirrorEngine, (daemon) =>
  Effect.try({ try: () => mirrorListOf(daemon), catch: (error) => error }),
);

// A start's session, opened inside the landing it is built on (sync.ts
// pullWorktreeThen, sendWorktreeThen), so the landing and the session
// are one uninterruptible step: a caller that leaves during the
// landing still gets its session. Opened, it is noted on the thread.
// Refused, there is no session, so no copy either: the pull (or the
// send) is undone, or a retry would refuse on the branch the failed
// attempt left behind, and the start fails with the create's error.
// The undo is best effort: its own failure is logged, not thrown over
// the real error. Either way: a mirror, or nothing, never a worktree
// the start left behind without its session.
const openSession = (
  daemon: MirrorImpl,
  create: MirrorCreateInput,
  ignoreMode: MirrorIgnoreMode,
  rollBack: () => Promise<unknown>,
  what: string,
) =>
  hostAttempt(() => daemon.create(create)).pipe(
    Effect.tapError(() =>
      Effect.promise(() =>
        rollBack().catch((rollbackError: unknown) => {
          console.warn(
            `[mirror] could not remove ${what} of a failed start: ${errorMessageOf(rollbackError)}`,
          );
        }),
      ),
    ),
    Effect.tap(() =>
      Effect.sync(() =>
        daemon.noteEvent(
          create.localWorktreeId,
          "started",
          summarizeIgnores(ignoreMode, create.ignores),
        ),
      ),
    ),
  );

// mirror:start. Every precondition before the pull, so a refusal
// creates nothing: the engine must be up, and the peer's worktree must
// exist (its root path is read off the peer's own list, because it
// flows into a session this device persists). The branch collision is
// the pull's own guard. The pull is interruptible up to its landing
// (see runPullWorktree), and the session opens inside the landing
// (see openSession).
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
    const { result, landing: session } = yield* pullWorktreeThen(
      pullInput,
      ctx,
      (pulled) =>
        openSession(
          daemon,
          {
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
          },
          ignoreMode,
          () => rollBackPull(pulled),
          "the worktree",
        ),
    );
    return { ...result, session };
  });

// mirror:startTo. The mirror turned around: one of this device's
// worktrees, sent to a peer and kept in step with the copy made there.
// The session runs here all the same (this device holds the original,
// the peer the copy, and the label says so for the stop), so like the
// send it rides the peer's grant alone. No leave-out rule goes to the
// send: the session it opens carries the ignored files and keeps
// carrying them, as in start. Interruptible up to the peer's landing,
// and the session opens inside it, for start's reason.
export const startMirrorTo = (
  input: typeof MirrorStartToPayloadSchema.Type,
  ctx: HandlerContext,
) =>
  Effect.gen(function* () {
    const daemon = yield* runningEngine;
    const apis = yield* peerApis;
    const { ignoreMode, ignores, ...sendInput } = input;
    const { result, landing: session } = yield* sendWorktreeThen(
      sendInput,
      ctx,
      (copy, source) =>
        openSession(
          daemon,
          {
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
          },
          ignoreMode,
          () =>
            apis.worktreesApiFor(input.targetDeviceId).delete({
              projectId: copy.projectId,
              worktreeId: copy.id,
              force: true,
            }),
          "the peer's copy",
        ),
    );
    return { ...result, session };
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
      return yield* new MirrorStopUnconfirmed({ status: git ?? "starting" });
    }
    const apis = yield* peerApis;
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* hostAttempt(() => daemon.terminate(session));
        // How the copy goes depends on where it is. What follows does
        // not: a copy that stayed is reported, with the session already
        // gone.
        const localWorktreeId = localWorktreeIdOf(raw);
        const projectId = raw.labels[MIRROR_LABEL_LOCAL_PROJECT];
        const onPeer = mirrorCopyIsRemote(raw);
        let stayed: string | null;
        if (onPeer) {
          stayed = yield* hostAttempt(() =>
            apis
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
              }, errorMessageOf),
          );
        } else if (localWorktreeId === "" || projectId === undefined) {
          stayed = "the session did not name its worktree";
        } else {
          // The ordinary delete, which takes the worktree's history
          // thread with it: there is no page left to show a "stopped"
          // line on.
          const removed = yield* deleteWorktree(
            { projectId, worktreeId: localWorktreeId, force: true },
            ctx,
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
          return yield* new MirrorCopyStayed({ onPeer, reason: stayed });
        }
      }),
    );
  });

// A pause or a resume. The engine's change and the thread's line about
// it are one step: a caller leaving between the two would leave a
// paused session whose thread never says so.
const changeThenNote = (
  session: string,
  change: "pause" | "resume",
  kind: "paused" | "resumed",
) =>
  Effect.flatMap(mirrorEngine, (daemon) =>
    hostAttempt(async () => {
      await daemon[change](session);
      daemon.noteEvent(
        localWorktreeIdOf(findSession(daemon, session)),
        kind,
        "",
      );
    }),
  ).pipe(Effect.as(undefined));

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: hostHandler(() => mirrorList),

  start: hostHandler((input, ctx: HandlerContext) => startMirror(input, ctx)),

  startTo: hostHandler((input, ctx: HandlerContext) =>
    startMirrorTo(input, ctx),
  ),

  stop: hostHandler((input, ctx: HandlerContext) =>
    stopMirror(input, ctx).pipe(Effect.as(undefined)),
  ),

  pause: hostHandler(({ session }) =>
    changeThenNote(session, "pause", "paused"),
  ),

  resume: hostHandler(({ session }) =>
    changeThenNote(session, "resume", "resumed"),
  ),

  // The engine cannot re-configure a live session, so a change of
  // ignores re-opens it on the same pair (MirrorImpl.recreate, which
  // keeps the old one until the new one is up and carries the git
  // follower's agreement across), the labels carried over. The pair's
  // files are already in agreement, so the new session's first cycle
  // has little to do. The recreate and the thread's line are one step,
  // so a caller that leaves once it is asked stops the wait, never the
  // swap: its answer is the only place the new id and the line come
  // from.
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
      const next = yield* hostAttempt(async () => {
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
      });
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

  // One step once the worktree is found: the apply moves the branch,
  // HEAD and the index in turn, and a caller that leaves stops the
  // wait, never the apply between them (the compare-and-set that
  // guards it is only checked at its start).
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
        const result = yield* hostAttempt(() =>
          applyGitState(
            project,
            { id: worktreeId, path: identity.path },
            { expect, state, sweep },
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
