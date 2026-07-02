import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  BranchListSchema,
  PathPayloadSchema,
  ProjectIconSchema,
  ProjectSchema,
  ProjectScopedPayloadSchema,
  ProjectSortModeSchema,
  RemoveProjectPayloadSchema,
  ReorderProjectsPayloadSchema,
  SetProjectSortPayloadSchema,
} from "@shared/schemas";

export const projectsContract = {
  list: invoke("projects:list", z.void(), z.array(ProjectSchema)),
  add: invoke("projects:add", PathPayloadSchema, ProjectSchema),
  remove: invoke("projects:remove", RemoveProjectPayloadSchema, z.void()),
  reorder: invoke("projects:reorder", ReorderProjectsPayloadSchema, z.void()),
  getSort: invoke("projects:getSort", z.void(), ProjectSortModeSchema),
  setSort: invoke("projects:setSort", SetProjectSortPayloadSchema, z.void()),
  // Emitted after an action bumps a project's usage so the renderer can
  // refresh its usage-sorted sidebar list.
  usageBumped: broadcast(
    "projects:usageBumped",
    z.object({ projectId: z.string() }),
  ),
  defaultBranch: invoke(
    "projects:defaultBranch",
    ProjectScopedPayloadSchema,
    z.string(),
  ),
  listBranches: invoke(
    "projects:listBranches",
    ProjectScopedPayloadSchema,
    BranchListSchema,
  ),
  pickWorktreeName: invoke(
    "projects:pickWorktreeName",
    ProjectScopedPayloadSchema,
    z.string(),
  ),
  listIgnoredPaths: invoke(
    "projects:listIgnoredPaths",
    ProjectScopedPayloadSchema,
    z.array(z.string()),
  ),
  icon: invoke(
    "projects:icon",
    ProjectScopedPayloadSchema,
    ProjectIconSchema.nullable(),
  ),
} as const;

export type ProjectsContract = typeof projectsContract;
