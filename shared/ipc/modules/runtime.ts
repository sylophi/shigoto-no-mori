import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  MoveDataDirPayloadSchema,
  NukeProgressSchema,
  RuntimeInfoSchema,
} from "@shared/schemas";

// Host lifecycle of the shigomori data dir. The client-side calls
// that used to ride along here live in the client-scoped modules now:
// theme preview and relaunch on window, appearance on clientConfig.
// nuke and moveDataDir stay on the Electron wire (remote false): they
// rewrite the host's data dir, which is nobody else's to do. info rides
// the wire so a peer's project pages can spell the paths a worktree
// will land at the same way the local ones do, behind the command
// grant like the fs reads (it names the host's homedir and data dir,
// which a peer this host has not granted control to has no use for).
// It moves no state, so it never pings viewers.
export const runtimeContract = defineContract("host", {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema, {
    remote: true,
    mutating: true,
    movesHostState: false,
  }),
  nuke: invoke("runtime:nuke", z.void(), z.void(), { remote: false }),
  moveDataDir: invoke(
    "runtime:moveDataDir",
    MoveDataDirPayloadSchema,
    z.void(),
    {
      remote: false,
    },
  ),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema, {
    remote: true,
  }),
});
