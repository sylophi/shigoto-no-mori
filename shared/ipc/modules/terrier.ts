import { Schema } from "effect";
import { defineContract, invoke } from "@shared/ipc/contract";
import { TerrierReadinessSchema } from "@shared/schemas";

export const terrierContract = defineContract("host", {
  readiness: invoke(
    "terrier:readiness",
    Schema.Undefined,
    TerrierReadinessSchema,
    { remote: true, mutating: false },
  ),
});
