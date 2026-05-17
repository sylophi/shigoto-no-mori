import { registerBranchHandlers } from "./branches";
import { registerFsHandlers } from "./fs";
import { registerGlobalConfigHandlers } from "./globalConfig";
import { registerLauncherHandlers } from "./launchers";
import { registerMenuHandlers } from "./menu";
import { registerPackageScriptHandlers } from "./packageScripts";
import { registerProjectHandlers } from "./projects";
import { registerRuntimeHandlers } from "./runtime";
import { registerScriptHandlers } from "./scripts";
import { registerShellHandlers } from "./shell";
import { registerShigomoriHandlers } from "./shigomori";
import { registerWorktreeHandlers } from "./worktrees";

export function registerIpcHandlers(): void {
  registerProjectHandlers();
  registerWorktreeHandlers();
  registerBranchHandlers();
  registerLauncherHandlers();
  registerScriptHandlers();
  registerPackageScriptHandlers();
  registerRuntimeHandlers();
  registerFsHandlers();
  registerShellHandlers();
  registerShigomoriHandlers();
  registerGlobalConfigHandlers();
  registerMenuHandlers();
}
