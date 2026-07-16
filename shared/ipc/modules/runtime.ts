import { z } from "zod";
import { broadcast, invoke } from "@shared/ipc/contract";
import {
  NukeProgressSchema,
  RuntimeInfoSchema,
  SetDoubutsuPayloadSchema,
  SetThemePayloadSchema,
} from "@shared/schemas";

export const runtimeContract = {
  info: invoke("runtime:info", z.void(), RuntimeInfoSchema),
  setTheme: invoke("runtime:setTheme", SetThemePayloadSchema, z.void()),
  setDoubutsu: invoke(
    "runtime:setDoubutsu",
    SetDoubutsuPayloadSchema,
    z.void(),
  ),
  nuke: invoke("runtime:nuke", z.void(), z.void()),
  nukeProgress: broadcast("runtime:nukeProgress", NukeProgressSchema),
} as const;

export type RuntimeContract = typeof runtimeContract;
