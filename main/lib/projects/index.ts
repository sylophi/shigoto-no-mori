// Shared helpers for reading projects from the store.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { unknownProjectError } from "@shared/errors";
import type { Project } from "@shared/schemas";
import { isSameOrInside } from "@shared/worktreeLayout";
import { PROJECTS_KEY, registryStore } from "../config/store";
import {
  findWorktreeIdentityOrThrow,
  type WorktreeIdentity,
} from "../git/worktrees";
import {
  refreshTerrierListings,
  terrierListingsSnapshot,
  terrierProjectId,
} from "../terrier";
import { shigomoriRoot, toAbsolute } from "../util/paths";
import { usageFor } from "./usage";

// Registry entries plus a read-only project per terrier repo the
// registry doesn't already hold, so terrier projects are first-class
// everywhere a project id resolves. Registry writes never see the
// merged entries: they re-read registry.json under its lock.
export function loadProjects(): Project[] {
  const registry = registryStore.readKey<Project[]>(PROJECTS_KEY, []);
  return mergeTerrierProjects(registry);
}

// Ordering must match appendTerrierProjects in cli/terrier.go:
// registry order first, terrier extras after, sorted by name then path
// (plain byte compare in both engines).
function mergeTerrierProjects(registry: Project[]): Project[] {
  const listings = terrierListingsSnapshot();
  if (listings.length === 0) return registry;
  const known = new Set(registry.map((p) => p.path));
  const extras: Project[] = [];
  for (const { path } of listings) {
    if (known.has(path)) continue;
    known.add(path);
    extras.push({
      id: terrierProjectId(path),
      name: basename(path),
      path,
      source: "terrier",
    });
  }
  extras.sort((a, b) =>
    a.name !== b.name
      ? byteCompare(a.name, b.name)
      : byteCompare(a.path, b.path),
  );
  return [...registry, ...extras];
}

function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Decorated with `pathExists` for renderer-side "this project is missing"
// affordances, plus `lastUsed` / `recentCount` for the sidebar sort modes.
// Only the ProjectsList IPC handler should call this. The list comes from
// registry.json and the usage from state.json, and usageFor falls back to
// zeros rather than throwing, so trouble in the second file can't take the
// list down with it. Async where every other reader takes the terrier
// snapshot: the sidebar is where terrier projects appear, so this is the
// read that must not serve a stale merge.
export async function listProjectsWithStatus(): Promise<Project[]> {
  await refreshTerrierListings();
  const projects = loadProjects();
  const usage = usageFor(projects.map((p) => p.id));
  return projects.map((p) => ({
    id: p.id,
    name: p.name,
    path: p.path,
    source: p.source,
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
