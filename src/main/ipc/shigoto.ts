import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { WriteShigotoPayloadSchema } from "@shared/schemas";
import { findProjectOrThrow } from "../projects";
import { writeShigotoConfig } from "../shigoto";

export function registerShigotoHandlers(): void {
  ipcMain.handle(CHANNELS.ShigotoWrite, async (_event, rawPayload: unknown) => {
    const { projectId, config } = WriteShigotoPayloadSchema.parse(rawPayload);
    findProjectOrThrow(projectId);
    await writeShigotoConfig(projectId, config);
  });
}
