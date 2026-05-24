import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  ReadWorktreeDataPayloadSchema,
  type ShigomoriWorktreeData,
  WriteShigomoriPayloadSchema,
  WriteWorktreeDataPayloadSchema,
} from "@shared/schemas";
import { IN_PROJECT_ROOT_DIR } from "@shared/worktreeLayout";
import { appendExcludes } from "../git/exclude";
import { findProjectOrThrow } from "../projects";
import {
  readWorktreeData,
  writeShigomoriConfig,
  writeWorktreeData,
} from "../config/project";

export function registerShigomoriHandlers(): void {
  ipcMain.handle(
    CHANNELS.ShigomoriWrite,
    async (_event, rawPayload: unknown) => {
      const { projectId, config } =
        WriteShigomoriPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      await writeShigomoriConfig(projectId, config);
      // Hide `.shigomori/` from the primary's `git status` whenever the
      // project opts into the in-project layout. Idempotent: appendExcludes
      // skips lines that already exist.
      if (config.worktreeLayout === "in-project") {
        try {
          await appendExcludes(project.path, [IN_PROJECT_ROOT_DIR]);
        } catch (err) {
          // Non-fatal: the user can still use the layout, they'll just see
          // .shigomori/ in their git status until they exclude it manually.
          console.warn(
            `[shigomori] couldn't append ${IN_PROJECT_ROOT_DIR} to info/exclude:`,
            err,
          );
        }
      }
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreeDataRead,
    async (
      _event,
      rawPayload: unknown,
    ): Promise<ShigomoriWorktreeData | null> => {
      const { projectId, worktreeId } =
        ReadWorktreeDataPayloadSchema.parse(rawPayload);
      // Validate projectId against the in-memory project list before any
      // path construction, so a bogus id can't read outside projects/.
      findProjectOrThrow(projectId);
      return readWorktreeData(projectId, worktreeId);
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreeDataWrite,
    async (_event, rawPayload: unknown) => {
      const { projectId, worktreeId, data } =
        WriteWorktreeDataPayloadSchema.parse(rawPayload);
      // The renderer doesn't surface a notes UI for external worktrees, so
      // we don't re-verify here -- enforcing the "no external state" rule
      // would mean shelling out to `git worktree list` on every save.
      // findProjectOrThrow + the WorktreeIdSchema regex keep the path-build
      // safe against malformed input.
      findProjectOrThrow(projectId);
      await writeWorktreeData(projectId, worktreeId, data);
    },
  );
}
