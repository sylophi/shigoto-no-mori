import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  type DirectoryListing,
  ListDirectoryPayloadSchema,
} from "@shared/schemas";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function registerFsHandlers(): void {
  ipcMain.handle(
    CHANNELS.FsListDirectory,
    async (_event, rawPayload: unknown): Promise<DirectoryListing> => {
      const { path } = ListDirectoryPayloadSchema.parse(rawPayload);

      const expanded = expandHome(path);
      const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);

      const entries = await readdir(absolute, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          isGitRepo: existsSync(join(absolute, e.name, ".git")),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name));

      return { path: absolute, entries: dirs };
    },
  );
}
