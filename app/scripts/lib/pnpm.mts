// How a script runs pnpm: `spawn(command, args, { shell })`. On
// Windows pnpm is a batch file, which only cmd starts (startable).
import { startable } from "@shigomori/engine/batchFiles";
import { byPlatform } from "@shigomori/engine/platform";

export const pnpm = (args: ReadonlyArray<string>) =>
  byPlatform({
    darwin: { command: "pnpm", args, shell: false },
    linux: { command: "pnpm", args, shell: false },
    win32: startable("pnpm.cmd", args),
  });
