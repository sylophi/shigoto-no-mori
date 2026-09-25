// Every per-worktree mark keyed by worktree id. A worktree's id is
// derived from its path, so the flows that move a worktree (relocate,
// a data-dir move) carry each mark to the new id through here, and a
// new mark only has to be added to this list.
import { autoPullMarks } from "./autoPull";
import { shelvedMarks } from "./shelved";

const worktreeMarks = [shelvedMarks, autoPullMarks];

export function moveWorktreeMarks(from: string, to: string): void {
  for (const marks of worktreeMarks) marks.move(from, to);
}

// For a worktree the app removes without the CLI (which retires marks
// itself on rm). A leftover mark would greet the next worktree at the
// same path.
export function dropWorktreeMarks(worktreeId: string): void {
  for (const marks of worktreeMarks) marks.drop(worktreeId);
}
