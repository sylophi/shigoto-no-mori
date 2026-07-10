import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import {
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
} as const;

export type RuntimeContract = typeof runtimeContract;
