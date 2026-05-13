// Shared helpers for reading projects from the store.
import type { Project } from "@shared/schemas";
import { readKey } from "./store";

const PROJECTS_KEY = "projects";

export function loadProjects(): Project[] {
  return readKey<Project[]>(PROJECTS_KEY, []);
}

export function findProjectOrThrow(projectId: string): Project {
  const project = loadProjects().find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return project;
}
