import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { WorktreeScopedPayloadSchema } from "@shared/schemas";

export const portPoolContract = {
  isActive: invoke(
    "portPool:isActive",
    WorktreeScopedPayloadSchema,
    z.boolean(),
  ),
  isInstalled: invoke("portPool:isInstalled", z.void(), z.boolean()),
} as const;
