import { branchesContract } from "@shigomori/contracts/modules/branches";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Engine from "@host/lib/engine";
import { findProject } from "@host/lib/projects";

export const branchesHandlers = {
  create: ({ projectId, name, base }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* (yield* Git.Git).createBranch({ repo: project.path, name, base });
    }),

  rename: ({ projectId, oldName, newName }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* (yield* Git.Git).renameBranch({
        repo: project.path,
        from: oldName,
        to: newName,
      });
    }),

  delete: ({ projectId, name, force }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* (yield* Git.Git).deleteBranch({
        repo: project.path,
        name,
        force: force ?? false,
      });
    }),
} satisfies EffectHandlers<
  typeof branchesContract,
  unknown,
  Engine.Services | ChildProcessSpawner.ChildProcessSpawner
>;
