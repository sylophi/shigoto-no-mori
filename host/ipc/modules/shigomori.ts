import { Effect } from "effect";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  invalidateProjectConfigCache,
  readShigomoriConfig,
  readWorktreeData,
  writeWorktreeData,
} from "@host/lib/config/project";
import { findProject } from "@host/lib/projects";
import { hostAttempt, hostHandler } from "@host/runtime";
import { shigomoriWriteViaCli } from "../cliDelegate";

export const shigomoriHandlers: Handlers<
  typeof shigomoriContract,
  HandlerContext
> = {
  read: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      return yield* hostAttempt(() => readShigomoriConfig(project.id));
    }),
  ),

  // Same engine rule as the other mutations: the CLI performs the write
  // (it also handles the in-project exclude side effect and validates
  // projectId, mapping onto the same unknown-project error). One step
  // with the invalidation, so a caller that leaves mid-write cannot
  // strand the stale config in the cache.
  write: hostHandler(({ projectId, config }) =>
    hostAttempt(async () => {
      await shigomoriWriteViaCli(projectId, config);
      // The watcher treats the delegated spawn as a self-write, so the
      // TTL cache must be dropped here rather than by the fs event.
      invalidateProjectConfigCache(projectId);
    }).pipe(Effect.as(undefined)),
  ),

  worktreeDataRead: hostHandler(({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      // Validate projectId against the in-memory project list before
      // any path construction, so a bogus id can't read outside
      // projects/.
      yield* findProject(projectId);
      return yield* hostAttempt(() => readWorktreeData(projectId, worktreeId));
    }),
  ),

  worktreeDataWrite: hostHandler(({ projectId, worktreeId, data }) =>
    Effect.gen(function* () {
      // The renderer only surfaces a notes UI for managed worktrees and
      // the primary checkout, so we don't re-verify here. Enforcing the
      // "no external state" rule would mean shelling out to `git
      // worktree list` on every save. findProject + the
      // WorktreeIdSchema regex keep the path-build safe against
      // malformed input.
      yield* findProject(projectId);
      yield* hostAttempt(() => writeWorktreeData(projectId, worktreeId, data));
      return undefined;
    }),
  ),
};
