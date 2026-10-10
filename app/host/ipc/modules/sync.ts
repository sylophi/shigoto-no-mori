// The wire for moving a worktree between devices: the handlers decode,
// call and answer. The landing is host/lib/sync/landing.ts, the pull
// and the send host/lib/sync/move.ts, the receipts and the teardown
// host/lib/sync/receipts.ts, and a source's answers
// host/lib/sync/sourceLink.ts.
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
import type { HostServices } from "@host/process/services";
import { landForSender } from "@host/lib/sync/landing";
import { pullWorktree, sendWorktree } from "@host/lib/sync/move";
import { teardownSource } from "@host/lib/sync/receipts";

export const syncHandlers = {
  hasCommits: async ({ projectId, commits }) => {
    const project = await findProjectOrThrow(projectId);
    const present: string[] = [];
    for (const commit of commits) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of cheap probes
      if (await hasCommit(project.path, commit)) present.push(commit);
    }
    return { present };
  },

  worktreeFolder: async ({ relative, ruleIgnored, ...input }) =>
    listWorktreeFolder(
      await findWorktreePathOrThrow(input),
      relative,
      ruleIgnored,
    ),

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
  teardownSource: (move, ctx: HandlerContext) =>
    teardownSource(move, (removal) => worktreesHandlers.delete(removal, ctx)),
} satisfies Handlers<typeof syncContract, HandlerContext, HostServices>;
