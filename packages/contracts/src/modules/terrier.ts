import { defineContract, invoke, ungated } from "../contract.ts";
import { TerrierReadinessSchema, VoidSchema } from "../schemas/index.ts";

export const terrierContract = defineContract(
  "terrier",
  { scope: "host", version: 1 },
  invoke("readiness", VoidSchema, TerrierReadinessSchema, ungated),
);
