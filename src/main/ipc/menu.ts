import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { SetLaunchToolsEnabledPayloadSchema } from "@shared/schemas";
import { setLaunchToolsEnabled } from "../menu";

export function registerMenuHandlers(): void {
  ipcMain.handle(
    CHANNELS.MenuSetLaunchToolsEnabled,
    async (_event, rawPayload: unknown) => {
      const { enabled, projectId } =
        SetLaunchToolsEnabledPayloadSchema.parse(rawPayload);
      await setLaunchToolsEnabled(enabled, projectId);
    },
  );
}
