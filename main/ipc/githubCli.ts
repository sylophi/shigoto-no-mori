import { ipcMain } from "electron";
import { z } from "zod";
import { CHANNELS } from "@shared/channels";
import {
  type GithubCliReadiness,
  MergePullRequestPayloadSchema,
  type PullRequest,
  type PullRequestDetail,
  type RepoMergeConfig,
  SetPullRequestDraftPayloadSchema,
} from "@shared/schemas";
import {
  getGithubCliReadiness,
  getPullRequestDiff,
  getRepoMergeConfig,
  getWorktreePullRequest,
  listProjectPullRequests,
  mergePullRequest,
  setPullRequestDraft,
} from "../githubCli";
import { findProjectOrThrow } from "../projects";

const ProjectPayloadSchema = z.object({
  projectId: z.string(),
});

const WorktreePullRequestPayloadSchema = z.object({
  projectId: z.string(),
  branch: z.string(),
});

const PullRequestDiffPayloadSchema = z.object({
  projectId: z.string(),
  number: z.number().int().positive(),
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
    async (_event, rawPayload: unknown): Promise<PullRequestDetail | null> => {
      const { projectId, branch } =
        WorktreePullRequestPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return getWorktreePullRequest(project.path, branch);
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliRepoMergeConfig,
    async (_event, rawPayload: unknown): Promise<RepoMergeConfig | null> => {
      const { projectId } = ProjectPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return getRepoMergeConfig(project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliMergePullRequest,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, number, method } =
        MergePullRequestPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await mergePullRequest({
        projectId,
        cwd: project.path,
        number,
        method,
      });
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliPullRequestDiff,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId, number } =
        PullRequestDiffPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return getPullRequestDiff({ cwd: project.path, number });
    },
  );

  ipcMain.handle(
    CHANNELS.GithubCliSetPullRequestDraft,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, number, draft } =
        SetPullRequestDraftPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await setPullRequestDraft({ cwd: project.path, number, draft });
    },
  );
}
