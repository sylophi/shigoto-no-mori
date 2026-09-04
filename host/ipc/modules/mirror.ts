// Host side of continuous worktree mirroring (shared/ipc/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/mirror/daemon.ts, spawned and supervised there), so it arrives
// through an injected impl following the setPortForwardEngine
// precedent. This module owns the rest: the start orchestration, the
// stream open a peer drives to mirror FROM here (with the serving
// registry and the served index watcher behind it), and the git half
// a peer's follower reads and applies.
//
// start = pull, then mirror. The pull (sync:pullWorktree's
// orchestration, reused verbatim) lands the peer's branch, commits and
// uncommitted changes as a new local worktree through the ordinary
// create, so setup and carry-over ride along and git agrees on both
// sides before a single file is watched. The mirror session then opens
// between that worktree and the peer's, with almost nothing left to
// move. The peer's root path is read off its own worktree list over
// the grant-gated wire, never taken from the caller.
import type { z } from "zod";
import {
  type MirrorGitStatus,
  type MirrorServing,
  type MirrorSession,
  MirrorSessionSchema,
  type MirrorStartPayloadSchema,
  mirrorContract,
} from "@shared/ipc/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { WorktreeSchema } from "@shared/schemas";
import { errorMessageOf, unknownWorktreeError } from "@shared/errors";
import { spawnFileSync } from "@host/fileSync/spawn";
import { peerWorktreesApiFor } from "@host/ipc/peerSync";
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
import { attachFarEnd, requireChannels } from "@host/socket/channelStreams";
import { runPullWorktree } from "./sync";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own. Ids only: the
// engine refuses label values outside its alphabet, and the branch is
// the local worktree's to report.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";
export const MIRROR_LABEL_LOCAL_WORKTREE = "localWorktreeId";

// What the daemon reports for one session, before annotation: the
// daemon's own document shape (file-sync/engine.go mirrorSessionState).
export type MirrorSessionRaw = Omit<
  MirrorSession,
  "localProjectId" | "localWorktreeId"
>;

// The create request the daemon takes (file-sync/engine.go
// mirrorRequest, the create fields).
export type MirrorCreateInput = {
  localRoot: string;
  deviceId: string;
  projectId: string;
  worktreeId: string;
  remoteRoot: string;
  name: string;
  labels: Record<string, string>;
};

export type MirrorImpl = {
  status: () => "stopped" | "starting" | "running" | "unavailable";
  sessions: () => MirrorSessionRaw[];
  create: (input: MirrorCreateInput) => Promise<string>;
  terminate: (session: string) => Promise<unknown>;
  pause: (session: string) => Promise<unknown>;
  resume: (session: string) => Promise<unknown>;
  // The git follower's verdict for a session (host/mirror/gitFollow.ts).
  gitStatus: (session: string) => MirrorGitStatus | undefined;
};

let impl: MirrorImpl | null = null;

export function setMirrorImpl(next: MirrorImpl): void {
  impl = next;
}

function engine(): MirrorImpl {
  if (impl === null) {
    throw new Error("mirror handler invoked before the daemon was wired");
  }
  return impl;
}

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

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: () => {
    const daemon = engine();
    return {
      daemon: daemon.status(),
      sessions: daemon
        .sessions()
        .map((raw) =>
          annotateMirrorSession(raw, daemon.gitStatus(raw.session)),
        ),
      serving: listMirrorServing(),
    };
  },

  start: async (input: z.infer<typeof MirrorStartPayloadSchema>, ctx) => {
    // Every precondition before the pull, so a refusal creates
    // nothing: the engine must be up, and the peer's worktree must
    // exist (its root path is read off the peer's own list and
    // re-parsed here, because it flows into a session this device
    // persists). The branch collision is the pull's own guard.
    const daemon = engine();
    if (daemon.status() !== "running") {
      throw new Error(
        daemon.status() === "unavailable"
          ? "Mirroring is unavailable on this device: the file-sync engine is missing."
          : "The mirror engine is still starting. Try again in a moment.",
      );
    }
    const peerWorktrees = WorktreeSchema.array().parse(
      await peerWorktreesApiFor(input.sourceDeviceId).list({
        projectId: input.sourceProjectId,
      }),
    );
    const source = peerWorktrees.find((w) => w.id === input.sourceWorktreeId);
    if (source === undefined)
      throw unknownWorktreeError(input.sourceWorktreeId);

    const pulled = await runPullWorktree(input, ctx);
    let session: string;
    try {
      session = await daemon.create({
        localRoot: pulled.worktree.path,
        deviceId: input.sourceDeviceId,
        projectId: input.sourceProjectId,
        worktreeId: input.sourceWorktreeId,
        remoteRoot: source.path,
        name: input.branch,
        labels: {
          [MIRROR_LABEL_LOCAL_PROJECT]: pulled.worktree.projectId,
          [MIRROR_LABEL_LOCAL_WORKTREE]: pulled.worktree.id,
        },
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
    return { ...pulled, session };
  },

  stop: async ({ session }) => {
    await engine().terminate(session);
  },
  pause: async ({ session }) => {
    await engine().pause(session);
  },
  resume: async ({ session }) => {
    await engine().resume(session);
  },

  // A mirror stream: the far end is a fresh `file-sync serve` for the
  // named worktree, spoken to over its stdio. The worktree must exist
  // in this host's registry (a peer can only mirror what this device
  // lists), and the child dies with the channel: a peer reset, an end
  // from both sides or the socket dying all kill it, and a child that
  // exits on its own ends the channel the ordinary way. The root path
  // the peer's Mutagen side names travels inside the protocol, which
  // this handler does not read: the grant is the wall, as everywhere
  // on the byte-stream surface.
  openStream: async ({ projectId, worktreeId, channelId }, ctx) => {
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
