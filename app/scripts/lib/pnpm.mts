// How a script runs pnpm: `spawn(command, args, { shell })`. On
// Windows pnpm is a batch file, which only cmd starts (startable).
import { startable } from "@shigomori/engine/batchFiles";
import { byFamily } from "@shigomori/engine/platform";

export const pnpm = (args: ReadonlyArray<string>) =>
  byFamily({
    posix: { command: "pnpm", args, shell: false },
    windows: startable("pnpm.cmd", args),
  });
