// Shared helpers for reading projects from the store.
import { existsSync } from "node:fs";
import { unknownProjectError } from "@shared/errors";
import type { Project } from "@shared/schemas";
import { isSameOrInside } from "@shared/worktreeLayout";
import { PROJECTS_KEY, registryStore } from "../config/store";
import { getRepoIdentity } from "../git/repoIdentity";
import {
  findWorktreeIdentityOrThrow,
  type WorktreeIdentity,
} from "../git/worktrees";
import { shigomoriRoot, toAbsolute } from "../util/paths";
import { usageFor } from "./usage";

export function loadProjects(): Project[] {
  return registryStore.readKey<Project[]>(PROJECTS_KEY, []);
}

// Decorated with `pathExists` for renderer-side "this project is missing"
// affordances, plus `lastUsed` / `recentCount` for the sidebar sort modes
// and `identity` for cross-device repo matching (the pull-a-worktree
// gate). Only the ProjectsList IPC handler should call this. The list
// comes from registry.json and the usage from state.json, and usageFor
// falls back to zeros rather than throwing, so trouble in the second file
// can't take the list down with it. Identity degrades the same way: a
// missing path or a failing probe reads as null (never matches), and the
// TTL cache in repoIdentity keeps the git cost off the steady state.
export function listProjectsWithStatus(): Promise<Project[]> {
  const projects = loadProjects();
  const usage = usageFor(projects.map((p) => p.id));
  return Promise.all(
    projects.map(async (p) => {
      const pathExists = existsSync(p.path);
      return {
        id: p.id,
        name: p.name,
        path: p.path,
        pathExists,
        lastUsed: usage[p.id]?.lastUsed ?? 0,
        recentCount: usage[p.id]?.recentCount ?? 0,
        identity: pathExists
          ? await getRepoIdentity(p.path).catch(() => null)
          : null,
      };
    }),
  );
}

// Resolves which LOCAL project a peer's project corresponds to, by repo
// identity (shared/repoIdentity.mts). First registry match wins: two
// local clones of the same repo are both legitimate targets, so the
// ambiguity is benign. Recomputed here from disk rather than trusted
// from the caller, so a pull can never be aimed at a non-matching repo.
export async function findProjectByIdentityOrThrow(
  identity: string,
): Promise<Project> {
  for (const project of loadProjects()) {
    if (!existsSync(project.path)) continue;
    // oxlint-disable-next-line no-await-in-loop -- first match wins, and the TTL cache absorbs repeats
    const candidate = await getRepoIdentity(project.path).catch(() => null);
    if (candidate !== null && candidate === identity) return project;
  }
  throw new Error(
    "No local project matches this repository. Add a clone of it to this device first.",
  );
}

// A project repo registered from inside the state root (nothing stops
// projects.add from accepting one) would be wiped or dragged along by
// root-wide operations. Nuke and root-move both refuse up front on
// this test. Takes the caller's already-loaded list so the guard adds
// no extra store read.
export function findProjectInsideRoot(
  projects: Project[],
): Project | undefined {
  const root = shigomoriRoot();
  return projects.find((p) => isSameOrInside(toAbsolute(p.path), root));
}

export function findProjectOrThrow(projectId: string): Project {
  const project = loadProjects().find((p) => p.id === projectId);
  if (!project) throw unknownProjectError(projectId);
  return project;
}

// The preamble every worktree-scoped IPC handler opens with, so a change
// to how a worktree is resolved lands in one place.
export async function findProjectAndWorktreeOrThrow(
  projectId: string,
  worktreeId: string,
): Promise<{ project: Project; worktree: WorktreeIdentity }> {
  const project = findProjectOrThrow(projectId);
  const worktree = await findWorktreeIdentityOrThrow(
    project.id,
    project.path,
    worktreeId,
  );
  return { project, worktree };
}
