// Shared helpers for reading projects from the store.
import { existsSync } from "node:fs";
import type { Project } from "@shared/schemas";
import { readKey } from "../config/store";

export const PROJECTS_KEY = "projects";

export function loadProjects(): Project[] {
  return readKey<Project[]>(PROJECTS_KEY, []);
}

// Decorated with `pathExists` for renderer-side "this project is missing"
// affordances. Only the ProjectsList IPC handler should call this.
export function listProjectsWithStatus(): Project[] {
  return loadProjects().map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    pathExists: existsSync(p.path),
  }));
}

export function findProjectOrThrow(projectId: string): Project {
  const project = loadProjects().find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}
