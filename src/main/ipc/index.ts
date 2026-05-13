import { registerLauncherHandlers } from "./launchers";
import { registerProjectHandlers } from "./projects";
import { registerScriptHandlers } from "./scripts";
import { registerWorktreeHandlers } from "./worktrees";

export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerWorktreeHandlers();
  registerLauncherHandlers();
  registerScriptHandlers();
}
