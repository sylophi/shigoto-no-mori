// Shared helpers for reading projects from the store.
import { existsSync } from "node:fs";
import { unknownProjectError } from "@shared/errors";
import type { Project } from "@shared/schemas";
import { isSameOrInside } from "@shared/worktreeLayout";
import { readKey } from "../config/store";
import { shigomoriRoot, toAbsolute } from "../util/paths";
import { usageFor } from "./usage";

export const PROJECTS_KEY = "projects";

export function loadProjects(): Project[] {
  return readKey<Project[]>(PROJECTS_KEY, []);
}

// Decorated with `pathExists` for renderer-side "this project is missing"
// affordances, plus `lastUsed` / `recentCount` for the sidebar sort modes.
// Only the ProjectsList IPC handler should call this.
export function listProjectsWithStatus(): Project[] {
  const projects = loadProjects();
  const usage = usageFor(projects.map((p) => p.id));
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    pathExists: existsSync(p.path),
    lastUsed: usage[p.id]?.lastUsed ?? 0,
    recentCount: usage[p.id]?.recentCount ?? 0,
  }));
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
