import { Effect } from "effect";
import { branchesContract } from "@shared/ipc/modules/branches";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  createLocalBranchEffect,
  deleteAnyLocalBranchEffect,
  renameAnyLocalBranchEffect,
} from "@host/lib/git/branches";
import { hostHandler } from "@host/runtime";
import { findProject } from "@host/lib/projects";

export const branchesHandlers: Handlers<
  typeof branchesContract,
  HandlerContext
> = {
  create: hostHandler(({ projectId, name, base }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* createLocalBranchEffect(project.path, name, base);
      return undefined;
    }),
  ),

  rename: hostHandler(({ projectId, oldName, newName }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* renameAnyLocalBranchEffect(project.path, oldName, newName);
      return undefined;
    }),
  ),

  // An unmerged branch without `force` fails as BranchNotMerged, whose
  // tag the renderer matches to offer the force retry.
  delete: hostHandler(({ projectId, name, force }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      yield* deleteAnyLocalBranchEffect(project.path, name, force ?? false);
      return undefined;
    }),
  ),
};
