import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { WriteShigomoriPayloadSchema } from "@shared/schemas";
import { appendExcludes } from "../gitExclude";
import { findProjectOrThrow } from "../projects";
import { writeShigomoriConfig } from "../shigomori";

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
        await appendExcludes(project.path, [".shigomori"]).catch(() => {
          // Non-fatal: the user can still use the layout, they'll just see
          // .shigomori/ in their git status until they exclude it manually.
        });
      }
    },
  );
}
