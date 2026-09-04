// Host side of continuous worktree mirroring (shared/ipc/modules/
// mirror.ts). The daemon that owns the sessions lives in main
// (main/mirror/daemon.ts, spawned and supervised there), so it arrives
// through an injected impl following the setPortForwardEngine
// precedent, and this module stays a handler map plus the one
// orchestration that composes a mirror out of existing pieces.
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
  type MirrorSession,
  MirrorSessionSchema,
  type MirrorStartPayloadSchema,
  mirrorContract,
} from "@shared/ipc/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { WorktreeSchema } from "@shared/schemas";
import { unknownWorktreeError } from "@shared/errors";
import { peerWorktreesApiFor } from "@host/ipc/peerSync";
import {
  findWorktreeIdentityOrThrow,
  listWorktreeIdentities,
} from "@host/lib/git/worktrees";
import {
  findProjectByIdentityOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { applyGitState, readGitState } from "@host/mirror/gitState";
import { listMirrorServing } from "./forward";
import { runPullWorktree } from "./sync";

// The label keys the start orchestration writes on a session, lifted
// back out for the renderer by annotate below. Labels are the one
// free-form slot Mutagen persists with a session, so they survive a
// daemon restart without any bookkeeping of our own.
export const MIRROR_LABEL_LOCAL_PROJECT = "localProjectId";
export const MIRROR_LABEL_LOCAL_WORKTREE = "localWorktreeId";
export const MIRROR_LABEL_BRANCH = "branch";

// What the daemon reports for one session, before annotation: the
// daemon's own document shape (file-sync/engine.go mirrorSessionState).
export type MirrorSessionRaw = Omit<
  MirrorSession,
  "localProjectId" | "localWorktreeId"
>;

export type MirrorImpl = {
  status: () => "stopped" | "starting" | "running" | "unavailable";
  sessions: () => MirrorSessionRaw[];
  create: (input: {
    localRoot: string;
    deviceId: string;
    projectId: string;
    worktreeId: string;
    remoteRoot: string;
    name: string;
    labels: Record<string, string>;
  }) => Promise<string>;
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

// The daemon's document with the two label-borne ids lifted to fields,
// validated against the contract so a daemon/app drift fails here
// with a schema error instead of as undefined in the renderer.
export function annotateMirrorSession(
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

export const mirrorHandlers: Handlers<typeof mirrorContract, HandlerContext> = {
  list: () => ({
    daemon: engine().status(),
    sessions: engine()
      .sessions()
      .map((raw) =>
        annotateMirrorSession(raw, engine().gitStatus(raw.session)),
      ),
    serving: listMirrorServing(),
  }),

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

  start: async (input: z.infer<typeof MirrorStartPayloadSchema>, ctx) => {
    // The peer's root path, from its own list and re-parsed here
    // because it flows into a session this device persists. Resolved
    // BEFORE the pull so a gone worktree refuses without creating
    // anything.
    const peerWorktrees = WorktreeSchema.array().parse(
      await peerWorktreesApiFor(input.sourceDeviceId).list({
        projectId: input.sourceProjectId,
      }),
    );
    const source = peerWorktrees.find((w) => w.id === input.sourceWorktreeId);
    if (source === undefined)
      throw unknownWorktreeError(input.sourceWorktreeId);

    // Collisions refuse with the fact the user can act on: the branch
    // already checked out here names the worktree holding it (the
    // pull's own guard covers a branch that merely exists). Mirroring
    // INTO an existing worktree is not offered yet.
    const localProject = await findProjectByIdentityOrThrow(
      input.sourceIdentity,
    );
    const holder = (
      await listWorktreeIdentities(localProject.id, localProject.path)
    ).find((w) => w.branch === input.branch);
    if (holder !== undefined) {
      throw new Error(
        `${input.branch} is already checked out at ${holder.path} on this device. Stop or delete that worktree first.`,
      );
    }

    const pulled = await runPullWorktree(input, ctx);
    const session = await engine().create({
      localRoot: pulled.worktree.path,
      deviceId: input.sourceDeviceId,
      projectId: input.sourceProjectId,
      worktreeId: input.sourceWorktreeId,
      remoteRoot: source.path,
      name: input.branch,
      labels: {
        [MIRROR_LABEL_LOCAL_PROJECT]: pulled.worktree.projectId,
        [MIRROR_LABEL_LOCAL_WORKTREE]: pulled.worktree.id,
        [MIRROR_LABEL_BRANCH]: input.branch,
      },
    });
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
};
