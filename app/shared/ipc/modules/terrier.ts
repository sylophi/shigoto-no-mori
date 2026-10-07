import * as Schema from "effect/Schema";
import { defineContract, invoke } from "@shared/ipc/contract";
import { TerrierReadinessSchema } from "@shared/schemas";

export const terrierContract = defineContract("host", {
  readiness: invoke("terrier:readiness", Schema.Void, TerrierReadinessSchema, {
    remote: true,
    gated: false,
  }),
});
