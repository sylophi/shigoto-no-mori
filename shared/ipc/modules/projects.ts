import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
import { invoke } from "@shared/ipc/contract";
import {
  AddProjectPayloadSchema,
  BranchListSchema,
  ListIgnoredPathsPayloadSchema,
  PickWorktreeNamePayloadSchema,
  ProjectIconPayloadSchema,
  ProjectIconSchema,
  ProjectSchema,
  ProjectsDefaultBranchPayloadSchema,
  ProjectsListBranchesPayloadSchema,
  RemoveProjectPayloadSchema,
  ReorderProjectsPayloadSchema,
} from "@shared/schemas";

export const projectsContract = {
  list: invoke("projects:list", z.void(), z.array(ProjectSchema)),
  add: invoke("projects:add", AddProjectPayloadSchema, ProjectSchema),
  remove: invoke("projects:remove", RemoveProjectPayloadSchema, z.void()),
  reorder: invoke("projects:reorder", ReorderProjectsPayloadSchema, z.void()),
  defaultBranch: invoke(
    "projects:defaultBranch",
    ProjectsDefaultBranchPayloadSchema,
    z.string(),
  ),
  listBranches: invoke(
    "projects:listBranches",
    ProjectsListBranchesPayloadSchema,
    BranchListSchema,
  ),
  pickWorktreeName: invoke(
    "projects:pickWorktreeName",
    PickWorktreeNamePayloadSchema,
    z.string(),
  ),
  listIgnoredPaths: invoke(
    "projects:listIgnoredPaths",
    ListIgnoredPathsPayloadSchema,
    z.array(z.string()),
  ),
  icon: invoke(
    "projects:icon",
    ProjectIconPayloadSchema,
    ProjectIconSchema.nullable(),
  ),
} as const;

export type ProjectsContract = typeof projectsContract;

const client = buildClient(projectsContract);

export const projects = {
  list: () => client.list(),
  add: (path: string) => client.add({ path }),
  remove: (id: string) => client.remove({ id }),
  reorder: (input: {
    draggedId: string;
    targetId: string;
    position: "before" | "after";
  }) => client.reorder(input),
  defaultBranch: (projectId: string) => client.defaultBranch({ projectId }),
  listBranches: (projectId: string) => client.listBranches({ projectId }),
  pickWorktreeName: (projectId: string) =>
    client.pickWorktreeName({ projectId }),
  listIgnoredPaths: (projectId: string) =>
    client.listIgnoredPaths({ projectId }),
  icon: (projectId: string) => client.icon({ projectId }),
} as const;
