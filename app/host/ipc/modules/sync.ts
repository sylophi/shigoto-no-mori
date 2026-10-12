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
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Git from "@shigomori/engine/Git";
import * as Worktrees from "@host/lib/Worktrees";
import * as Effect from "effect/Effect";
import {
  findProject,
  findProjectAndWorktree,
  findWorktreePath,
} from "@host/lib/projects";
import * as Moves from "@host/lib/sync/Moves";
import {
  attachLinkFarEnd,
  serveSource,
  linkSource,
} from "@host/lib/sync/sourceLink";
import { worktreesHandlers } from "./worktrees";
import type { HostServices } from "@host/process/services";
import { landForSender } from "@host/lib/sync/landing";
import { pullWorktree, sendWorktree } from "@host/lib/sync/move";
import { teardownSource } from "@host/lib/sync/receipts";

export const syncHandlers = {
  hasCommits: ({ projectId, commits }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const git = yield* Git.Git;
      // A handful of cheap probes, one at a time.
      const present = yield* Effect.filter(commits, (commit) =>
        git.hasCommit(project.path, commit),
      );
      return { present };
    }),

  worktreeFolder: ({ relative, ruleIgnored, ...input }) =>
    Effect.flatMap(
      Effect.all([findWorktreePath(input), Worktrees.Worktrees]),
      ([path, worktrees]) =>
        worktrees.worktreeFolder(path, relative, ruleIgnored),
    ),

  // The ignored files a capture leaves behind (see the contract note):
  // listed against the worktree, not the project, so a peer's
  // transplant dialog can name what a teardown would take with it.
  ignoredPaths: (input) =>
    Effect.flatMap(
      Effect.all([findWorktreePath(input), Worktrees.Worktrees, Git.Git]),
      ([path, worktrees, git]) =>
        Effect.map(
          Effect.all(
            [worktrees.ignoredPaths(path), git.listIgnoreRules(path)],
            { concurrency: 2 },
          ),
          ([paths, patterns]) => ({
            paths: paths.slice(0, SYNC_IGNORED_PATHS_LIMIT),
            total: paths.length,
            patterns,
          }),
        ),
    ),

  // A pull's link (and the git follower's fetch): this host is the
  // source, answering until the peer is done. The open returns once
  // the link is attached, and the serving runs on without it.
  openSource: ({ projectId, worktreeId, channelId }, ctx) =>
    Effect.gen(function* () {
      const link = attachLinkFarEnd(ctx, channelId);
      const { project } = yield* findProjectAndWorktree(
        projectId,
        worktreeId,
      ).pipe(Effect.tapError(() => Effect.sync(() => link.reset())));
      // Served past this call's answer, its answers continuing the
      // trace of the peer's call.
      yield* Effect.forkDetach(
        Effect.ignore(serveSource(link, project, worktreeId)),
      );
    }),

  // A send's landing, run here for the sender (host/lib/sync/landing.ts).
  receiveWorktree: landForSender,

  // The cancel, of a move this device runs (a pull, a send, a mirror
  // start) or lands for the calling peer. Keyed like the progress the
  // caller is watching. False once there is nothing left to cancel.
  cancelMove: ({ sourceWorktreeId }, ctx) =>
    Effect.flatMap(Moves.Moves, (moves) =>
      Effect.map(moves.cancel(ctx, sourceWorktreeId), (cancelled) => ({
        cancelled,
      })),
    ),

  // The git follower's push: the peer opened the link, and this host
  // asks it for the one bundle and unpacks it under refs/shigomori/.
  receiveBundle: ({ projectId, refs, haves, channelId }, ctx) =>
    Effect.gen(function* () {
      const link = attachLinkFarEnd(ctx, channelId);
      const into = yield* findProject(projectId).pipe(
        Effect.tapError(() => Effect.sync(() => link.reset())),
      );
      return yield* Effect.scoped(
        Effect.flatMap(linkSource(link), (source) =>
          source.fetch({ refs, haves, into }),
        ),
      );
    }),

  pullWorktree,

  sendWorktree: (input, ctx) =>
    Effect.map(sendWorktree(input, ctx), ({ result }) => result),

  // The source teardown, after either move (host/lib/sync/receipts.ts).
  // A send's source is this device's own, removed by the ordinary delete.
  teardownSource: (move, ctx: HandlerContext) =>
    teardownSource(move, (removal) => worktreesHandlers.delete(removal, ctx)),
} satisfies EffectHandlers<typeof syncContract, HandlerContext, HostServices>;
