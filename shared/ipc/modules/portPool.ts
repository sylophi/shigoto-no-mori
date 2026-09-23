import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import { WorktreeScopedPayloadSchema } from "@shared/schemas";

export const portPoolContract = defineContract("host", {
  isActive: invoke(
    "portPool:isActive",
    WorktreeScopedPayloadSchema,
    Schema.Boolean,
    { remote: true, mutating: false },
  ),
  isInstalled: invoke(
    "portPool:isInstalled",
    Schema.Undefined,
    Schema.Boolean,
    {
      remote: true,
      mutating: false,
    },
  ),
});
