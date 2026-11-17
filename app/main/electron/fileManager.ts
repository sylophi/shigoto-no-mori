import { byPlatform } from "@shigomori/engine/platform";

// A dialog's button that reveals a file in this machine's file manager.
export const showInFileManager = () =>
  byPlatform({
    darwin: "Show in Finder",
    linux: "Show in Folder",
    win32: "Show in File Explorer",
  });
