// Shared types between main and renderer. Schema-validated counterparts
// will live in src/shared/schemas.ts once IPC contracts land.

export type WorktreeStatus =
  | "clean"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged";

export interface CommitSummary {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601 string. */
  date: string;
}

export interface Worktree {
  id: string;
  projectId: string;
  branch: string;
  path: string;
  status: WorktreeStatus;
  ahead: number;
  behind: number;
  dirtyCount: number;
  lastCommit: CommitSummary;
  /** Marker for the project's primary / root worktree (often main/master). */
  isPrimary?: boolean;
  /** Optional port allocated by the project's port-pool config. */
  port?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  worktrees: Worktree[];
}
