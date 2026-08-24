import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { WorktreeScopedPayloadSchema } from "@shared/schemas";

export const portPoolContract = defineContract("host", {
  isActive: invoke(
    "portPool:isActive",
    WorktreeScopedPayloadSchema,
    z.boolean(),
    { remote: true },
  ),
  isInstalled: invoke("portPool:isInstalled", z.void(), z.boolean(), {
    remote: true,
  }),
});
