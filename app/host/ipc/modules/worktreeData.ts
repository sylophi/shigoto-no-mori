import type { worktreeDataContract } from "@shigomori/contracts/modules/worktreeData";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";
import { currentWorktreeId, findProject } from "@host/lib/projects";

export const worktreeDataHandlers = {
  // Validate projectId against the project list before any read, so a
  // bogus id names nothing. A mirror's peer may name its copy by the id
  // it had before a move, here and in describe.
  read: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      yield* findProject(projectId);
      const data = yield* Ops.readWorktreeData(projectId, worktreeId);
      if (data !== null) return data;
      const now = yield* currentWorktreeId(projectId, worktreeId);
      return now === worktreeId
        ? null
        : yield* Ops.readWorktreeData(projectId, now);
    }),

  // The renderer only surfaces a ports editor for managed worktrees
  // and the primary checkout, so we don't re-verify here. Enforcing the
  // "no external state" rule would mean asking the engine for the
  // worktree list on every save. findProject + the WorktreeIdSchema
  // regex keep the keys well formed against malformed input.
  write: ({ projectId, worktreeId, data }) =>
    Effect.andThen(
      findProject(projectId),
      Ops.writeWorktreeData(projectId, worktreeId, data),
    ).pipe(Effect.asVoid),

  describe: ({ projectId, worktreeId, description }) =>
    Effect.andThen(
      findProject(projectId),
      currentWorktreeId(projectId, worktreeId),
    ).pipe(
      Effect.flatMap((id) =>
        Ops.writeWorktreeDescription(projectId, id, description),
      ),
      Effect.asVoid,
    ),
} satisfies EffectHandlers<
  typeof worktreeDataContract,
  unknown,
  Engine.Services
>;
