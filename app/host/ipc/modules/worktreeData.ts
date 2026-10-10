import type { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { EffectHandlers } from "@shared/ipc/registerContract";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import { findProject } from "@host/lib/projects";

export const worktreeDataHandlers = {
  // Validate projectId against the project list before any path
  // construction, so a bogus id can't read outside projects/.
  read: ({ projectId, worktreeId }) =>
    Effect.andThen(
      findProject(projectId),
      Ops.readWorktreeData(projectId, worktreeId),
    ),

  // The renderer only surfaces a ports editor for managed worktrees
  // and the primary checkout, so we don't re-verify here. Enforcing the
  // "no external state" rule would mean asking the engine for the
  // worktree list on every save. findProject + the WorktreeIdSchema
  // regex keep the path-build safe against malformed input.
  write: ({ projectId, worktreeId, data }) =>
    Effect.andThen(
      findProject(projectId),
      Ops.writeWorktreeData(projectId, worktreeId, data),
    ).pipe(Effect.asVoid),

  describe: ({ projectId, worktreeId, description }) =>
    Effect.andThen(
      findProject(projectId),
      Ops.writeWorktreeDescription(projectId, worktreeId, description),
    ).pipe(Effect.asVoid),
} satisfies EffectHandlers<
  typeof worktreeDataContract,
  unknown,
  Engine.Services
>;
