// Host side of continuous worktree mirroring (shared/ipc/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/core/mirror/daemon.ts, spawned and supervised there), so it arrives
// through an injected impl following the setPortForwardEngine
// precedent. This module owns the rest: the start orchestration, the
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
import type { z } from "zod";
import {
  MIRROR_LABEL_COPY_SIDE,
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
import { DeleteWorktreeResultSchema } from "@shared/schemas";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf, unknownWorktreeError } from "@shared/errors";
import { spawnFileSync } from "@host/fileSync/spawn";
import {
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
import { deleteAnyLocalBranch } from "@host/lib/git/branches";
import {
  findWorktreeIdentityOrThrow,
  removeWorktreeForce,
} from "@host/lib/git/worktrees";
import { findProjectOrThrow } from "@host/lib/projects";
import {
  applyGitState,
  readGitState,
  watchIndexFile,
} from "@host/mirror/gitState";
import {
  engine,
  engineOrNull,
  findSession,
  ignoreModeOf,
  localWorktreeIdOf,
  MIRROR_LABEL_IGNORE_MODE,
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  type MirrorSessionRaw,
  mirrorSessions,
  requireRunningEngine,
} from "@host/mirror/registry";
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { runPullWorktree, sendWorktree } from "./sync";
import { worktreesHandlers } from "./worktrees";

// The daemon slot, the session labels and the raw session shapes live
// in host/mirror/registry.ts, where the worktree delete can reach them
// without importing this module (which reaches sync, which reaches
// worktrees). Re-exported so the daemon and the follower keep one
// import path.
export {
  MIRROR_LABEL_LOCAL_PROJECT,
  MIRROR_LABEL_LOCAL_WORKTREE,
  setMirrorImpl,
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
let onServingChange: (() => void) | null = null;
let onServingGitChange:
  | ((change: { projectId: string; worktreeId: string }) => void)
  | null = null;

// main installs the two broadcast hooks at boot. Before that (and in
// checks that never mount them) changes are simply unannounced.
export function setMirrorServingListener(listener: (() => void) | null): void {
  onServingChange = listener;
}

export function setMirrorGitChangedListener(
  listener:
    | ((change: { projectId: string; worktreeId: string }) => void)
    | null,
): void {
  onServingGitChange = listener;
}

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
  onServingChange?.();
}

// The daemon's document with the two label-borne ids lifted to fields,
// validated against the contract so a daemon/app drift fails here
// with a schema error instead of as undefined in the renderer.
function annotateMirrorSession(
  raw: MirrorSessionRaw,
  git?: MirrorGitStatus,
): MirrorSession {
  return MirrorSessionSchema.parse({
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
  await deleteAnyLocalBranch(project.path, worktree.branch, true);
}

// A device's mirror picture: what mirror:list answers and what
// mirror:changed carries. The same for every caller.
function mirrorListOf(daemon: ReturnType<typeof engine>): MirrorListResult {
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

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: () => mirrorListOf(engine()),

  start: async (input: z.infer<typeof MirrorStartPayloadSchema>, ctx) => {
    // Every precondition before the pull, so a refusal creates
    // nothing: the engine must be up, and the peer's worktree must
    // exist (its root path is read off the peer's own list, because
    // it flows into a session this device persists). The branch
    // collision is the pull's own guard.
    const daemon = requireRunningEngine();
    const source = await peerWorktreeOrUndefined(
      input.sourceDeviceId,
      input.sourceProjectId,
      input.sourceWorktreeId,
    );
    if (source === undefined)
      throw unknownWorktreeError(input.sourceWorktreeId);

    const { ignoreMode, ignores, ...pullInput } = input;
    const pulled = await runPullWorktree(pullInput, ctx);
    let session: string;
    try {
      session = await daemon.create({
        localRoot: pulled.worktree.path,
        deviceId: input.sourceDeviceId,
        projectId: input.sourceProjectId,
        worktreeId: input.sourceWorktreeId,
        remoteRoot: source.path,
        name: input.branch,
        localWorktreeId: pulled.worktree.id,
        labels: {
          [MIRROR_LABEL_LOCAL_PROJECT]: pulled.worktree.projectId,
          [MIRROR_LABEL_LOCAL_WORKTREE]: pulled.worktree.id,
          [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
        },
        ignores,
      });
    } catch (error) {
      // No session, so no worktree either: the pull is undone (the
      // branch and its uncommitted changes are still on the peer), or
      // a retry would refuse on the branch the failed attempt left
      // behind. Best effort. A rollback failure is logged, not thrown
      // over the real error.
      await rollBackPull(pulled.worktree).catch((rollbackError: unknown) => {
        console.warn(
          `[mirror] could not remove the worktree of a failed start: ${errorMessageOf(rollbackError)}`,
        );
      });
      throw error;
    }
    daemon.noteEvent(
      pulled.worktree.id,
      "started",
      summarizeIgnores(ignoreMode, ignores),
    );
    return { ...pulled, session };
  },

  // The mirror turned around: one of this device's worktrees, sent to
  // a peer and kept in step with the copy made there. The session runs
  // here all the same (this device holds the original, the peer the
  // copy, and the label says so for the stop), so like the send it
  // rides the peer's grant alone. No leave-out rule goes to the send:
  // the session opened next carries the ignored files and keeps
  // carrying them, as in start.
  startTo: async (input: z.infer<typeof MirrorStartToPayloadSchema>, ctx) => {
    const daemon = requireRunningEngine();
    const { ignoreMode, ignores, ...sendInput } = input;
    const { source: worktree, result: sent } = await sendWorktree(
      sendInput,
      ctx,
    );
    const copy = {
      projectId: sent.worktree.projectId,
      worktreeId: sent.worktree.id,
    };
    let session: string;
    try {
      session = await daemon.create({
        localRoot: worktree.path,
        deviceId: input.targetDeviceId,
        ...copy,
        // The copy's root as the peer's landing answered it, re-parsed
        // by the send.
        remoteRoot: sent.worktree.path,
        name: worktree.branch,
        localWorktreeId: worktree.id,
        labels: {
          [MIRROR_LABEL_LOCAL_PROJECT]: input.projectId,
          [MIRROR_LABEL_LOCAL_WORKTREE]: worktree.id,
          [MIRROR_LABEL_IGNORE_MODE]: ignoreMode,
          [MIRROR_LABEL_COPY_SIDE]: "remote",
        },
        ignores,
      });
    } catch (error) {
      // No session, so no copy either, for start's reason: a retry
      // would refuse on the branch the failed attempt left on the
      // peer. Best effort, and logged, not thrown over the real error.
      await peerWorktreesApiFor(input.targetDeviceId)
        .delete({ ...copy, force: true })
        .catch((rollbackError: unknown) => {
          console.warn(
            `[mirror] could not remove the peer's copy of a failed start: ${errorMessageOf(rollbackError)}`,
          );
        });
      throw error;
    }
    daemon.noteEvent(
      worktree.id,
      "started",
      summarizeIgnores(ignoreMode, ignores),
    );
    return { ...sent, session };
  },

  // Stop ends the session and removes the copy the mirror made: the
  // mirror was the copy's reason to exist, and the source keeps the
  // branch. The copy is this device's worktree, or the peer's for a
  // mirror started to it (startTo), where the original here stays. The delete follows the terminate (the other way round the
  // tombstone protocol would stop the session itself, mid-delete) and
  // is forced, since the copy carries the source's uncommitted state
  // by design. A copy the delete cannot remove is reported with the
  // session already gone: the worktree page then offers the ordinary
  // delete.
  stop: async ({ session, force }, ctx) => {
    const daemon = engine();
    const raw = findSession(daemon, session);
    if (raw === undefined) {
      throw new Error("That mirror is no longer running.");
    }
    // The copy goes with the stop. Refusing on "diverged" alone read
    // as safe exactly when it cannot know: a paused session reports
    // "off" and an unreachable peer "error", since divergence is
    // computed against a live peer. So anything but "synced" refuses.
    const git = daemon.gitStatus(session)?.status;
    if (force !== true && !mirrorStopIsSafe(git)) {
      throw new Error(
        `${MIRROR_STOP_UNCONFIRMED} (${git ?? "starting"}), so it may hold commits that exist nowhere else. Resume or reconnect the mirror to let it catch up, or stop it anyway to discard them.`,
      );
    }
    await daemon.terminate(session);
    // How the copy goes depends on where it is. What follows does not:
    // a copy that stayed is reported, with the session already gone.
    const localWorktreeId = localWorktreeIdOf(raw);
    const projectId = raw.labels[MIRROR_LABEL_LOCAL_PROJECT];
    const onPeer = mirrorCopyIsRemote(raw);
    let stayed: string | null;
    if (onPeer) {
      stayed = await peerWorktreesApiFor(raw.deviceId)
        .delete({
          projectId: raw.projectId,
          worktreeId: raw.worktreeId,
          force: true,
        })
        .then((result) => {
          const removed = DeleteWorktreeResultSchema.parse(result);
          return removed.ok
            ? null
            : `its ${removed.cleanupError.phase} step failed`;
        }, errorMessageOf);
    } else if (localWorktreeId === "" || projectId === undefined) {
      stayed = "the session did not name its worktree";
    } else {
      // The ordinary delete, which takes the worktree's history thread
      // with it: there is no page left to show a "stopped" line on.
      const removed = await worktreesHandlers.delete(
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
      throw new Error(
        `The mirror stopped, but the copy ${onPeer ? "on the other device" : "here"} stayed: ${stayed}. Delete it from its page.`,
      );
    }
  },
  pause: async ({ session }) => {
    const daemon = engine();
    await daemon.pause(session);
    daemon.noteEvent(
      localWorktreeIdOf(findSession(daemon, session)),
      "paused",
      "",
    );
  },
  resume: async ({ session }) => {
    const daemon = engine();
    await daemon.resume(session);
    daemon.noteEvent(
      localWorktreeIdOf(findSession(daemon, session)),
      "resumed",
      "",
    );
  },

  // The engine cannot re-configure a live session, so a change of
  // ignores re-opens it on the same pair (MirrorImpl.recreate, which
  // keeps the old one until the new one is up and carries the git
  // follower's agreement across), the labels carried over. The pair's
  // files are already in agreement, so the new session's first cycle
  // has little to do.
  setIgnores: async ({ session, ignoreMode, ignores }) => {
    const daemon = engine();
    const raw = findSession(daemon, session);
    if (raw === undefined) {
      throw new Error("That mirror is no longer running.");
    }
    const localWorktreeId = localWorktreeIdOf(raw);
    const next = await daemon.recreate(session, {
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
    return { session: next };
  },

  history: ({ localWorktreeId }) => ({
    events: engine().history(localWorktreeId),
  }),

  // A mirror stream: the far end is a fresh `file-sync serve` for the
  // named worktree, spoken to over its stdio. The worktree must exist
  // in this host's registry (a peer can only mirror what this device
  // lists), and the child dies with the channel: a peer reset, an end
  // from both sides or the socket dying all kill it, and a child that
  // exits on its own ends the channel the ordinary way. The root path
  // the peer's Mutagen side names travels inside the protocol, which
  // this handler does not read: the grant is the wall, as everywhere
  // on the byte-stream surface.
  openStream: async (
    { projectId, worktreeId, channelId, peerWorktreeId },
    ctx,
  ) => {
    requireChannels(ctx, channelId);
    const project = findProjectOrThrow(projectId);
    const identity = await findWorktreeIdentityOrThrow(
      projectId,
      project.path,
      worktreeId,
    );
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
    void watchIndexFile(identity.path, () =>
      onServingGitChange?.({ projectId, worktreeId }),
    ).then(
      (stop) => {
        if (serving.get(key) === served) served.stopIndexWatch = stop;
        else stop();
      },
      () => {},
    );
    onServingChange?.();
  },

  // The git half served to the device mirroring from here (see
  // host/mirror/gitState.ts): the worktree must be one this host
  // lists, and the state is read or applied in place.
  gitState: async ({ projectId, worktreeId }) => {
    const project = findProjectOrThrow(projectId);
    const identity = await findWorktreeIdentityOrThrow(
      projectId,
      project.path,
      worktreeId,
    );
    return readGitState(project.path, identity.path, worktreeId);
  },

  applyGitState: async ({ projectId, worktreeId, expect, state, sweep }) => {
    const project = findProjectOrThrow(projectId);
    const identity = await findWorktreeIdentityOrThrow(
      projectId,
      project.path,
      worktreeId,
    );
    const result = await applyGitState(
      project,
      { id: worktreeId, path: identity.path },
      { expect, state, sweep },
    );
    return result.applied
      ? { applied: true }
      : { applied: false, reason: result.reason };
  },
};
