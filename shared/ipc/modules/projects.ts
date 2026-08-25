import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
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
  SetSidebarViewPayloadSchema,
  SidebarViewSchema,
  ToggleCollapsedProjectPayloadSchema,
  WorktreeIncludeStatusSchema,
} from "@shared/schemas";

export const projectsContract = defineContract("host", {
  list: invoke("projects:list", z.void(), z.array(ProjectSchema), {
    remote: true,
    mutating: false,
  }),
  add: invoke("projects:add", PathPayloadSchema, ProjectSchema, {
    remote: false,
  }),
  remove: invoke("projects:remove", RemoveProjectPayloadSchema, z.void(), {
    remote: false,
  }),
  reorder: invoke("projects:reorder", ReorderProjectsPayloadSchema, z.void(), {
    remote: false,
  }),
  getSort: invoke("projects:getSort", z.void(), ProjectSortModeSchema, {
    remote: true,
    mutating: false,
  }),
  setSort: invoke("projects:setSort", SetProjectSortPayloadSchema, z.void(), {
    remote: false,
  }),
  getSidebarView: invoke(
    "projects:getSidebarView",
    z.void(),
    SidebarViewSchema,
    {
      remote: true,
      mutating: false,
    },
  ),
  setSidebarView: invoke(
    "projects:setSidebarView",
    SetSidebarViewPayloadSchema,
    z.void(),
    { remote: false },
  ),
  getCollapsed: invoke("projects:getCollapsed", z.void(), z.array(z.string()), {
    remote: true,
    mutating: false,
  }),
  // Returns the post-toggle list so the renderer can sync to disk truth.
  toggleCollapsed: invoke(
    "projects:toggleCollapsed",
    ToggleCollapsedProjectPayloadSchema,
    z.array(z.string()),
    { remote: false },
  ),
  // Emitted after an action bumps a project's usage so the renderer can
  // refresh its usage-sorted sidebar list.
  usageBumped: broadcast("projects:usageBumped", ProjectScopedPayloadSchema, {
    remote: true,
  }),
  defaultBranch: invoke(
    "projects:defaultBranch",
    ProjectScopedPayloadSchema,
    z.string(),
    { remote: true, mutating: false },
  ),
  listBranches: invoke(
    "projects:listBranches",
    ProjectScopedPayloadSchema,
    BranchListSchema,
    { remote: true, mutating: false },
  ),
  pickWorktreeName: invoke(
    "projects:pickWorktreeName",
    ProjectScopedPayloadSchema,
    z.string(),
    { remote: true, mutating: false },
  ),
  listIgnoredPaths: invoke(
    "projects:listIgnoredPaths",
    ProjectScopedPayloadSchema,
    z.array(z.string()),
    { remote: true, mutating: false },
  ),
  worktreeIncludeStatus: invoke(
    "projects:worktreeIncludeStatus",
    ProjectScopedPayloadSchema,
    WorktreeIncludeStatusSchema,
    { remote: true, mutating: false },
  ),
  icon: invoke(
    "projects:icon",
    ProjectScopedPayloadSchema,
    ProjectIconSchema.nullable(),
    { remote: true, mutating: false },
  ),
});
