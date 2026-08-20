import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  MoveRootPayloadSchema,
  NukeProgressSchema,
  RuntimeInfoSchema,
  SetThemePayloadSchema,
} from "@shared/schemas";

export const runtimeContract = {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema),
  setTheme: invoke("runtime:setTheme", SetThemePayloadSchema, z.void()),
  nuke: invoke("runtime:nuke", z.void(), z.void()),
  moveRoot: invoke("runtime:moveRoot", MoveRootPayloadSchema, z.void()),
  // Renderer-acknowledged restart after a successful moveRoot: firing
  // this only after the moveRoot reply resolves guarantees the reply
  // was delivered before the app quits -- no timing guesses.
  relaunch: invoke("runtime:relaunch", z.void(), z.void()),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema),
} as const;
