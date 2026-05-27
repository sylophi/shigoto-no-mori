import { projectsContract } from "@shared/modules/projects/contract";
import { projectsHandlers } from "../modules/projects/handlers";
import { registerBranchHandlers } from "./branches";
import { registerDialogHandlers } from "./dialog";
import { registerFsHandlers } from "./fs";
import { registerGithubCliHandlers } from "./githubCli";
import { registerGlobalConfigHandlers } from "./globalConfig";
import { registerLauncherHandlers } from "./launchers";
import { registerMenuHandlers } from "./menu";
import { registerPackageScriptHandlers } from "./packageScripts";
import { registerPortPoolHandlers } from "./portPool";
import { registerContract } from "./register";
import { registerRuntimeHandlers } from "./runtime";
import { registerScriptHandlers } from "./scripts";
import { registerShellHandlers } from "./shell";
import { registerShigomoriHandlers } from "./shigomori";
import { registerUpdaterHandlers } from "./updater";
import { registerWorktreeHandlers } from "./worktrees";

export function registerIpcHandlers(): void {
  registerContract(projectsContract, projectsHandlers);
  registerDialogHandlers();
  registerWorktreeHandlers();
  registerBranchHandlers();
  registerLauncherHandlers();
  registerScriptHandlers();
  registerPackageScriptHandlers();
  registerPortPoolHandlers();
  registerGithubCliHandlers();
  registerRuntimeHandlers();
  registerFsHandlers();
  registerShellHandlers();
  registerShigomoriHandlers();
  registerGlobalConfigHandlers();
  registerMenuHandlers();
  registerUpdaterHandlers();
}
