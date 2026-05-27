import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type GlobalConfig,
  WriteGlobalConfigPayloadSchema,
} from "@shared/schemas";
import { readGlobalConfig, writeGlobalConfig } from "../lib/config/global";

export function registerGlobalConfigHandlers(): void {
  ipcMain.handle(
    CHANNELS.GlobalConfigRead,
    (): Promise<GlobalConfig> => readGlobalConfig(),
  );

  ipcMain.handle(
    CHANNELS.GlobalConfigWrite,
    async (_event, rawPayload: unknown) => {
      const { config } = WriteGlobalConfigPayloadSchema.parse(rawPayload);
      await writeGlobalConfig(config);
    },
  );
}
