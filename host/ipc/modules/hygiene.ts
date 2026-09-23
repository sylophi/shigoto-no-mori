import { Effect } from "effect";
import { hygieneContract } from "@shared/ipc/modules/hygiene";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  collectProjectHygieneEffect,
  findWorktreeForDiskEffect,
  measureWorktreeDiskEffect,
} from "@host/lib/worktrees/hygiene";
import { hostHandler } from "@host/runtime";
import { findProject } from "@host/lib/projects";

export const hygieneHandlers: Handlers<typeof hygieneContract, HandlerContext> =
  {
    list: hostHandler(({ projectId }) =>
      Effect.flatMap(findProject(projectId), (project) =>
        collectProjectHygieneEffect(project.id, project.path),
      ),
    ),

    diskUsage: hostHandler(({ projectId, worktreeId }) =>
      Effect.gen(function* () {
        const project = yield* findProject(projectId);
        const worktree = yield* findWorktreeForDiskEffect(
          project.id,
          project.path,
          worktreeId,
        );
        return yield* measureWorktreeDiskEffect(
          project.id,
          project.path,
          worktree,
        );
      }),
    ),
  };
