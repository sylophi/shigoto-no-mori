// Shared helpers for reading projects from the store.
import { existsSync } from "node:fs";
import { unknownProjectError } from "@shared/errors";
import type { Project } from "@shared/schemas";
import { readKey } from "../config/store";
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

export function findProjectOrThrow(projectId: string): Project {
  const project = loadProjects().find((p) => p.id === projectId);
  if (!project) throw unknownProjectError(projectId);
  return project;
}
