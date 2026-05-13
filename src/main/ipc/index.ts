import { registerProjectHandlers } from "./projects";
import { registerWorktreeHandlers } from "./worktrees";

export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerWorktreeHandlers();
}
