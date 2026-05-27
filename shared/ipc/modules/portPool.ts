import { z } from "zod";
import { buildClient } from "@shared/ipc/buildClient";
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

const client = buildClient(portPoolContract);

export const portPool = {
  isActive: client.isActive,
  isInstalled: () => client.isInstalled(),
} as const;
