// Host side of continuous worktree mirroring (shared/ipc/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/core/mirror/daemon.ts, spawned and supervised there), so it arrives
// through an injected impl following the setPortForwardEngine
// precedent. This module owns the rest: the start orchestration, the
// stream open a peer drives to mirror FROM here (with the serving
// registry and the served index watcher behind it), and the git half
// a peer's follower reads and applies.
//
// start = move, then mirror. The move (sync's pull or send, reused
// verbatim) lands the worktree's branch, commits and uncommitted
// changes as a new worktree through the ordinary create, so carry-over
// (and setup, when the dialog asked for it) ride along and git agrees
// on both sides before a single file is watched. The mirror session
// then opens between the two worktrees, with almost nothing left to
// move. Either way round, the session runs HERE, on the device that
// started it: the session reaches the other side's `file-sync serve`
// and git state through that device's grant (openStream, gitState,
// applyGitState), which is the grant the move already needed. A pull
// (start) leaves the copy here, a send (startTo) leaves it on the
// peer, and the session's copySide label, set from which way the move
// went, says which one a stop removes. The peer's root path is read
// off its own answers over the grant-gated wire, never taken from the
// caller.
//
// A primary checkout is mirrored the same way, its copy on
// mirror/<branch> in a mirror-<name> folder (shared/git/branches.ts),
// and the session labelled so the git follower reads the two branch
// names as one. Both primaries keep what they had.
import type { z } from "zod";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_MIRROR_BRANCH,
  MIRROR_COPY_STAYED,
  MIRROR_STOP_UNCONFIRMED,
  mirrorCopyIsRemote,
  type MirrorGitStatus,
  type MirrorIgnoreMode,
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
import { forceRemoveViaCli } from "@host/ipc/cliDelegate";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { errorMessageOf, unknownWorktreeError } from "@shared/errors";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
import { spawnFileSync } from "@host/fileSync/spawn";
import {
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
import { deleteAnyLocalBranch } from "@host/lib/git/branches";
import { localBranchExists } from "@host/lib/git/remotes";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
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
import type { MirrorCreateInput, MirrorImpl } from "@host/mirror/registry";

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

// Undoes a pull whose session never started. The worktree goes through
// `sm rm` like any removal, so the port-pool lease its create took is
// released, its teardown runs and the CLI retires the marks it seeded.
// The branch goes whatever deleteBranchOnRemove says: a retry would
// refuse on the one this attempt left behind.
async function rollBackPull(
  worktree: Pick<Worktree, "id" | "projectId" | "branch">,
): Promise<void> {
  const project = await findProjectOrThrow(worktree.projectId);
  await forceRemoveViaCli(project, worktree.id);
  if (await localBranchExists(project.path, worktree.branch)) {
    await deleteAnyLocalBranch(project.path, worktree.branch, true);
  }
}

// A session created for a start, noted on the worktree's thread. A
// create that fails undoes what the start landed first (the rollback
// is best effort: its own failure is logged, not thrown over the real
// error).
async function openSession(
  daemon: MirrorImpl,
  input: MirrorCreateInput,
  ignoresSummary: string,
  rollBack: { what: string; run: () => Promise<unknown> },
): Promise<string> {
  let session: string;
  try {
    session = await daemon.create(input);
  } catch (error) {
    await rollBack.run().catch((rollbackError: unknown) => {
      console.warn(
        `[mirror] could not remove ${rollBack.what} of a failed start: ${errorMessageOf(rollbackError)}`,
      );
    });
    throw error;
  }
  daemon.noteEvent(input.localWorktreeId, "started", ignoresSummary);
  return session;
}

// The session a start opens once its move landed, whichever way the
// move went: between the worktree here and the one on the peer, the
// copy on the side the move put it. No session, so no copy either: the
// move is undone (the original still holds the branch and its
// uncommitted changes), or a retry would refuse on the branch the
// failed attempt left behind.
async function openMirror(
  daemon: MirrorImpl,
  mirror: {
    here: Pick<Worktree, "id" | "projectId" | "path" | "branch">;
    there: Pick<Worktree, "id" | "projectId" | "path"> & { deviceId: string };
    copy: "here" | "there";
    branch: string;
    primary: boolean;
    ignoreMode: MirrorIgnoreMode;
    ignores: string[];
  },
): Promise<string> {
  const { here, there } = mirror;
  return openSession(
    daemon,
    {
      localRoot: here.path,
      deviceId: there.deviceId,
      projectId: there.projectId,
      worktreeId: there.id,
      remoteRoot: there.path,
      name: mirror.branch,
      localWorktreeId: here.id,
      labels: {
        [MIRROR_LABEL_LOCAL_PROJECT]: here.projectId,
        [MIRROR_LABEL_LOCAL_WORKTREE]: here.id,
        [MIRROR_LABEL_IGNORE_MODE]: mirror.ignoreMode,
        ...(mirror.copy === "there"
          ? { [MIRROR_LABEL_COPY_SIDE]: "remote" }
          : {}),
        ...(mirror.primary ? { [MIRROR_LABEL_MIRROR_BRANCH]: "1" } : {}),
      },
      ignores: mirror.ignores,
    },
    summarizeIgnores(mirror.ignoreMode, mirror.ignores),
    mirror.copy === "here"
      ? { what: "the worktree", run: () => rollBackPull(here) }
      : {
          what: "the peer's copy",
          run: () =>
            peerWorktreesApiFor(there.deviceId).delete({
              projectId: there.projectId,
              worktreeId: there.id,
              force: true,
            }),
        },
  );
}

async function pauseOrResume(
  session: string,
  verb: "pause" | "resume",
  noted: "paused" | "resumed",
): Promise<void> {
  const daemon = engine();
  await daemon[verb](session);
  daemon.noteEvent(localWorktreeIdOf(findSession(daemon, session)), noted, "");
}

// The sessions a stop has ended whose copy is still being removed,
// as last listed. The engine drops a session at terminate, and the
// copy's delete follows for seconds. Listed through that, the pair
// keeps reading as one worktree (the sidebar folds it, the page keeps
// its pill) instead of the copy surfacing as a worktree of its own
// until it vanishes.
const stopping = new Map<string, MirrorSession>();

// A device's mirror picture: what mirror:list answers and what
// mirror:changed carries. The same for every caller.
function mirrorListOf(daemon: ReturnType<typeof engine>): MirrorListResult {
  const sessions = mirrorSessions(daemon).map((raw) =>
    annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
  );
  const live = new Set(sessions.map((session) => session.session));
  for (const [id, session] of stopping) {
    if (!live.has(id)) sessions.push(session);
  }
  return {
    daemon: daemon.status(),
    sessions,
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

// The stop past the safety check: the engine ends the session, then
// the copy goes. How the copy goes depends on where it is. What
// follows does not: a copy that stayed is reported, with the session
// already gone.
async function stopAndRemoveCopy(
  daemon: ReturnType<typeof engine>,
  session: string,
  raw: MirrorSessionRaw,
  ctx: HandlerContext,
): Promise<void> {
  await daemon.terminate(session);
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
      `${MIRROR_COPY_STAYED} ${onPeer ? "on the other device" : "here"} stayed: ${stayed}. Delete it from its page.`,
    );
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

    // Where a primary's copy lands is decided by what the source is,
    // off the peer's list, not by the caller. The branch is the
    // caller's, like the commits fetched under it: the peer may have
    // switched since it was listed.
    const { ignoreMode, ignores, ...pullInput } = input;
    const pulled = await runPullWorktree(
      source.isPrimary
        ? { ...pullInput, worktreeName: pullWorktreeName(source) }
        : pullInput,
      ctx,
      {
        landBranch: pullLandingBranch({
          branch: input.branch,
          isPrimary: source.isPrimary,
        }),
      },
    );
    const session = await openMirror(daemon, {
      here: pulled.worktree,
      there: { ...source, deviceId: input.sourceDeviceId },
      copy: "here",
      branch: input.branch,
      primary: source.isPrimary,
      ignoreMode,
      ignores,
    });
    return { ...pulled, session };
  },

  // The mirror the other way round: one of this device's worktrees,
  // sent to a peer and kept in step with the copy made there. No
  // leave-out rule goes to the send: the session opened next carries
  // the ignored files and keeps carrying them, as in start.
  startTo: async (input: z.infer<typeof MirrorStartToPayloadSchema>, ctx) => {
    const daemon = requireRunningEngine();
    const { ignoreMode, ignores, ...sendInput } = input;
    const { source, result: sent } = await sendWorktree(sendInput, ctx, {
      mirror: true,
    });
    const session = await openMirror(daemon, {
      here: source,
      // The copy's root as the peer's landing answered it, re-parsed
      // by the send.
      there: { ...sent.worktree, deviceId: input.targetDeviceId },
      copy: "there",
      branch: source.branch,
      primary: source.isPrimary,
      ignoreMode,
      ignores,
    });
    return { ...sent, session };
  },

  // Stop ends the session and removes the copy the mirror made: the
  // mirror was the copy's reason to exist, and the source keeps the
  // branch. The copy is this device's worktree, or the peer's for a
  // mirror started to it (startTo), where the original here stays. The
  // delete follows the terminate (the other way round the
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
    stopping.set(session, {
      ...annotateMirrorSession(raw, daemon.gitStatus(session)),
      stopping: true,
    });
    try {
      await stopAndRemoveCopy(daemon, session, raw, ctx);
    } finally {
      stopping.delete(session);
      onServingChange?.();
    }
  },
  pause: ({ session }) => pauseOrResume(session, "pause", "paused"),
  resume: ({ session }) => pauseOrResume(session, "resume", "resumed"),

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
    const worktreePath = await findWorktreePathOrThrow({
      projectId,
      worktreeId,
    });
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
    const { project, worktree: identity } = await findProjectAndWorktreeOrThrow(
      projectId,
      worktreeId,
    );
    return readGitState(project.path, identity.path, worktreeId);
  },

  applyGitState: async ({ projectId, worktreeId, expect, state, sweep }) => {
    const { project, worktree: identity } = await findProjectAndWorktreeOrThrow(
      projectId,
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
