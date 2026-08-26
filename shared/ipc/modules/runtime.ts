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
export const runtimeContract = defineContract("host", {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema),
  nuke: invoke("runtime:nuke", z.void(), z.void()),
  moveRoot: invoke("runtime:moveRoot", MoveRootPayloadSchema, z.void()),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema),
});
