import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import { SetLaunchToolsEnabledPayloadSchema } from "@shared/schemas";
import { setLaunchToolsEnabled } from "../menu";

export function registerMenuHandlers(): void {
  ipcMain.handle(
    CHANNELS.MenuSetLaunchToolsEnabled,
    (_event, rawPayload: unknown) => {
      const { enabled, entries } =
        SetLaunchToolsEnabledPayloadSchema.parse(rawPayload);
      setLaunchToolsEnabled(enabled, entries);
    },
  );
}
