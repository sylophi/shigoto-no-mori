import { registerFsHandlers } from "./fs";
import { registerLauncherHandlers } from "./launchers";
import { registerProjectHandlers } from "./projects";
import { registerRuntimeHandlers } from "./runtime";
import { registerScriptHandlers } from "./scripts";
import { registerShellHandlers } from "./shell";
import { registerShigotoHandlers } from "./shigoto";
import { registerWorktreeHandlers } from "./worktrees";

export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerWorktreeHandlers();
  registerLauncherHandlers();
  registerScriptHandlers();
  registerRuntimeHandlers();
  registerFsHandlers();
  registerShellHandlers();
  registerShigotoHandlers();
}
