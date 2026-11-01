import { defineContract, invoke, ungated } from "../contract.ts";
import { TerrierReadinessSchema, VoidSchema } from "../schemas/index.ts";

export const terrierContract = defineContract(
  "terrier",
  "host",
  invoke("readiness", VoidSchema, TerrierReadinessSchema, ungated),
);
