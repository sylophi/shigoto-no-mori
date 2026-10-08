import { broadcast, defineContract, invoke } from "../contract.ts";
import {
  MoveDataDirPayloadSchema,
  NukeProgressSchema,
  RuntimeInfoSchema,
  VoidSchema,
} from "../schemas/index.ts";

// Host lifecycle of the shigomori data dir. The client-side calls
// that used to ride along here live in the client-scoped modules now:
// theme preview and relaunch on window, appearance on clientConfig.
// nuke stays on the Electron wire (remote false): wiping a machine is
// for whoever sits at it. moveDataDir rides the wire behind the command
// grant, so a peer's Settings page can relocate that device's data
// folder. The host relaunches itself after such a call, since the peer
// has no window module to acknowledge with (host/ipc/modules/runtime).
// info rides the wire so a peer's project pages can spell the paths a
// worktree will land at the same way the local ones do, behind the
// command grant like the fs reads (it names the host's homedir and
// data dir, which a peer this host has not granted control to has no
// use for). It moves no state, so it never pings viewers.
export const runtimeContract = defineContract("host", {
  info: invoke("runtime:info", VoidSchema, RuntimeInfoSchema, {
    remote: true,
    gated: true,
    movesHostState: false,
  }),
  nuke: invoke("runtime:nuke", VoidSchema, VoidSchema, { remote: false }),
  moveDataDir: invoke(
    "runtime:moveDataDir",
    MoveDataDirPayloadSchema,
    VoidSchema,
    // The host restarts right after, and the session that comes back
    // refetches everything, so the viewer ping would only race the
    // quit.
    { remote: true, gated: true, movesHostState: false },
  ),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema, {
    remote: true,
  }),
});
