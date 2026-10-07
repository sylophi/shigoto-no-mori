import { defineContract, invoke } from "@shared/ipc/contract";
import { TerrierReadinessSchema, VoidSchema } from "@shared/schemas";

export const terrierContract = defineContract("host", {
  readiness: invoke("terrier:readiness", VoidSchema, TerrierReadinessSchema, {
    remote: true,
    gated: false,
  }),
});
