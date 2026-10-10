import { branchesContract } from "@shigomori/contracts/modules/branches";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Engine from "@host/lib/engine";
import {
  createLocalBranch,
  deleteAnyLocalBranch,
  renameAnyLocalBranch,
} from "@host/lib/git/branches";
import { findProject } from "@host/lib/projects";

export const branchesHandlers = {
  create: ({ projectId, name, base }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      createLocalBranch(project.path, name, base),
    ),

  rename: ({ projectId, oldName, newName }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      renameAnyLocalBranch(project.path, oldName, newName),
    ),

  delete: ({ projectId, name, force }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      deleteAnyLocalBranch(project.path, name, force ?? false),
    ),
} satisfies Handlers<
  typeof branchesContract,
  unknown,
  Engine.Services | ChildProcessSpawner.ChildProcessSpawner
>;
