// Host side of moving a worktree between devices. The landing (the
// copy made on the destination) is ONE function, landWorktree, run on
// the destination whichever device started the move: a pull runs it
// here against a link it opened to the source, a send asks the peer to
// run it (sync:receiveWorktree) against a link this device opened and
// answers on. The source's side of either is host/lib/sync/
// sourceLink.ts. What stays per direction is what the grant decides:
// the files step (the mirror engine run once, from the device holding
// the grant) and the teardown (the source's delete, on its own device
// or over the peer's grant).
//
// The handlers decode, call and answer. The landing is
// host/lib/sync/landing.ts, the pull and the send host/lib/sync/move.ts,
// and the receipts and the teardown host/lib/sync/receipts.ts.
import {
  SYNC_IGNORED_PATHS_LIMIT,
  syncContract,
} from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shigomori/contracts/types";
import { type Project } from "@shigomori/contracts/schemas";
import { listIgnoreRules } from "@host/lib/git/ignoreRules";
import {
  cachedIgnoredPaths,
  listWorktreeFolder,
} from "@host/lib/worktrees/carryOver";
import { hasCommit } from "@host/lib/git/refs";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
  findWorktreePathOrThrow,
} from "@host/lib/projects";
import { cancelMove } from "@host/lib/sync/moves";
import {
  attachLinkFarEnd,
  serveSource,
  withLinkSource,
} from "@host/lib/sync/sourceLink";
import { worktreesHandlers } from "./worktrees";
import { landForSender } from "@host/lib/sync/landing";
import { pullWorktree, sendWorktree } from "@host/lib/sync/move";
import { teardownSource } from "@host/lib/sync/receipts";

export const syncHandlers: Handlers<typeof syncContract, HandlerContext> = {
  hasCommits: async ({ projectId, commits }) => {
    const project = await findProjectOrThrow(projectId);
    const present: string[] = [];
    for (const commit of commits) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      if (await hasCommit(project.path, commit)) present.push(commit);
    }
    return { present };
  },

  worktreeFolder: async ({ relative, ...input }) =>
    listWorktreeFolder(await findWorktreePathOrThrow(input), relative),

  // The ignored files a capture leaves behind (see the contract note):
  // listed against the worktree, not the project, so a peer's
  // transplant dialog can name what a teardown would take with it.
  ignoredPaths: async (input) => {
    const path = await findWorktreePathOrThrow(input);
    const [paths, patterns] = await Promise.all([
      cachedIgnoredPaths(path),
      listIgnoreRules(path),
    ]);
    return {
      paths: paths.slice(0, SYNC_IGNORED_PATHS_LIMIT),
      total: paths.length,
      patterns,
    };
  },

  // A pull's link (and the git follower's fetch): this host is the
  // source, answering until the peer is done. The open returns once
  // the link is attached, and the serving runs on without it.
  openSource: async ({ projectId, worktreeId, channelId }, ctx) => {
    const link = attachLinkFarEnd(ctx, channelId);
    let project: Project;
    try {
      ({ project } = await findProjectAndWorktreeOrThrow(
        projectId,
        worktreeId,
      ));
    } catch (error) {
      link.reset();
      throw error;
    }
    void serveSource(link, project, worktreeId).catch(() => {});
  },

  // A send's landing, run here for the sender (host/lib/sync/landing.ts).
  receiveWorktree: landForSender,

  // The cancel, of a move this device runs (a pull, a send, a mirror
  // start) or lands for the calling peer. Keyed like the progress the
  // caller is watching. False once there is nothing left to cancel.
  cancelMove: async ({ sourceWorktreeId }, ctx) => ({
    cancelled: cancelMove(ctx, sourceWorktreeId),
  }),

  // The git follower's push: the peer opened the link, and this host
  // asks it for the one bundle and unpacks it under refs/shigomori/.
  receiveBundle: async ({ projectId, refs, haves, channelId }, ctx) => {
    const link = attachLinkFarEnd(ctx, channelId);
    return withLinkSource(link, async (source) =>
      source.fetch({ refs, haves, into: await findProjectOrThrow(projectId) }),
    );
  },

  pullWorktree,

  sendWorktree: async (input, ctx) => (await sendWorktree(input, ctx)).result,

  // The source teardown, after either move (host/lib/sync/receipts.ts).
  // A send's source is this device's own, removed by the ordinary delete.
  teardownSource: (move, ctx) =>
    teardownSource(move, (removal) => worktreesHandlers.delete(removal, ctx)),
};
