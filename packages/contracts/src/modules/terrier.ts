import { defineContract, invoke } from "../contract.ts";
import { TerrierReadinessSchema, VoidSchema } from "../schemas/index.ts";

export const terrierContract = defineContract("host", {
  readiness: invoke("terrier:readiness", VoidSchema, TerrierReadinessSchema, {
    remote: true,
    gated: false,
  }),
});
