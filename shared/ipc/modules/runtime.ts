import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import {
  MoveRootPayloadSchema,
  NukeProgressSchema,
  RuntimeInfoSchema,
} from "@shared/schemas";

// Host lifecycle of the shigomori data root. The client-side calls
// that used to ride along here live in the client-scoped modules now:
// theme preview and relaunch on window, appearance on clientConfig.
// Local-only module: every call stays on the Electron wire (remote
// false). nuke, moveRoot and info touch host paths and the homedir, so a remote peer must never reach them.
export const runtimeContract = defineContract("host", {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema, { remote: false }),
  nuke: invoke("runtime:nuke", z.void(), z.void(), { remote: false }),
  moveRoot: invoke("runtime:moveRoot", MoveRootPayloadSchema, z.void(), {
    remote: false,
  }),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema, {
    remote: true,
  }),
});
