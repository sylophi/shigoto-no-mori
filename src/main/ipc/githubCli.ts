import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import type { GithubCliReadiness } from "@shared/schemas";
import { getGithubCliReadiness } from "../githubCli";

export function registerGithubCliHandlers(): void {
  ipcMain.handle(
    CHANNELS.GithubCliReadiness,
    async (): Promise<GithubCliReadiness> => {
      return getGithubCliReadiness();
    },
  );
}
