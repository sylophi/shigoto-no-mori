import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "@shared/channels";
import type { GithubCliReadiness, PullRequest } from "@shared/schemas";
import {
  getGithubCliReadiness,
  getWorktreePullRequest,
  listProjectPullRequests,
} from "../githubCli";
import { findProjectOrThrow } from "../projects";

const ProjectPayloadSchema = z.object({
  projectId: z.string(),
});

const WorktreePullRequestPayloadSchema = z.object({
  projectId: z.string(),
  branch: z.string(),
});

export function registerGithubCliHandlers(): void {
  ipcMain.handle(
    CHANNELS.GithubCliReadiness,
    async (): Promise<GithubCliReadiness> => {
      return getGithubCliReadiness();
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliProjectPullRequests,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<Record<string, PullRequest>> => {
      const { projectId } = ProjectPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const map = await listProjectPullRequests(project.path);
      // Maps don't survive structured clone across IPC -- ship as a record.
      return Object.fromEntries(map);
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliWorktreePullRequest,
    async (_event, rawPayload: unknown): Promise<PullRequest | null> => {
      const { projectId, branch } =
        WorktreePullRequestPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return getWorktreePullRequest(project.path, branch);
    },
  );
}
