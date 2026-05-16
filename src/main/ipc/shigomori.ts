import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { WriteShigomoriPayloadSchema } from "@shared/schemas";
import { findProjectOrThrow } from "../projects";
import { writeShigomoriConfig } from "../shigomori";

export function registerShigomoriHandlers(): void {
  ipcMain.handle(
    CHANNELS.ShigomoriWrite,
    async (_event, rawPayload: unknown) => {
      const { projectId, config } =
        WriteShigomoriPayloadSchema.parse(rawPayload);
      findProjectOrThrow(projectId);
      await writeShigomoriConfig(projectId, config);
    },
  );
}
