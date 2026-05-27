import type { Project, Worktree } from "@shared/schemas";

export type SidebarRow =
  | { kind: "project"; key: string; project: Project; expanded: boolean }
  | { kind: "worktree"; key: string; worktree: Worktree }
  | { kind: "worktree-skeleton"; key: string; projectId: string }
  | { kind: "worktree-error"; key: string; projectId: string }
  | {
      kind: "shelved-toggle";
      key: string;
      projectId: string;
      count: number;
      expanded: boolean;
    };

export const ROW_SIZE_HINTS: Record<SidebarRow["kind"], number> = {
  project: 28,
  worktree: 40,
  "worktree-skeleton": 36,
  "worktree-error": 24,
  "shelved-toggle": 24,
};
