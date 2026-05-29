import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { PortPoolIsActivePayloadSchema } from "@shared/schemas";

export const portPoolContract = {
  isActive: invoke(
    "portPool:isActive",
    PortPoolIsActivePayloadSchema,
    z.boolean(),
  ),
  isInstalled: invoke("portPool:isInstalled", z.void(), z.boolean()),
} as const;

export type PortPoolContract = typeof portPoolContract;
