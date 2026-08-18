import type { ReactNode } from "react";
import { bestScore } from "@/lib/fuzzyMatch";
import type { Project, Worktree } from "@shared/schemas";

// Where the user was when the palette opened. Drives which contextual
// actions are offered and which project's worktrees sort to the top.
export interface PaletteContext {
  projectId: string | null;
  worktreeId: string | null;
}

const WORKTREE_PATH = /^\/projects\/([^/]+)\/worktrees\/([^/]+)/;
const PROJECT_PATH = /^\/projects\/([^/]+)/;

// Deliberately unanchored at the end: the diff, pr-diff, commit and
// script-console routes all hang off a worktree, and standing on one of
// them still means "this worktree is what I'm working on".
export function parsePaletteContext(pathname: string): PaletteContext {
  const worktree = WORKTREE_PATH.exec(pathname);
  if (worktree) return { projectId: worktree[1], worktreeId: worktree[2] };
  const project = PROJECT_PATH.exec(pathname);
  if (project) return { projectId: project[1], worktreeId: null };
  return { projectId: null, worktreeId: null };
}

// One row. `value` is the cmdk identity (namespaced by kind so a project
// and its primary worktree can't collide); `terms` are the strings the
// fuzzy ranker scores against; `run` is what ↩ does.
export type PaletteItem = {
  value: string;
  terms: string[];
  run: () => void;
} & (
  | {
      kind: "worktree";
      project: Project;
      worktree: Worktree;
      isCurrent: boolean;
    }
  | { kind: "project"; project: Project; worktreeCount: number }
  | {
      kind: "action";
      label: string;
      icon: ReactNode;
      detail?: string;
      shortcut?: string;
    }
);

export interface PaletteSection {
  id: string;
  heading: string;
  items: PaletteItem[];
}

// Filter + rank one section's rows. An empty query keeps the caller's
// order (matching scoreMatch's "empty query = stable sort" contract), so
// an untouched palette reads as the curated list the caller assembled.
// Array.prototype.sort is stable, so ties also keep that order.
export function rankItems(
  query: string,
  items: readonly PaletteItem[],
): PaletteItem[] {
  if (!query) return [...items];
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const score = bestScore(query, item.terms);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}
