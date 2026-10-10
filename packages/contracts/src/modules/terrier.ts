import { defineContract, invoke } from "../contract.ts";
import {
  TerrierReadinessSchema,
  TerrierReposSchema,
  VoidSchema,
} from "../schemas/index.ts";

export const terrierContract = defineContract(
  "terrier",
  "host",
  invoke("readiness", VoidSchema, TerrierReadinessSchema, {
    remote: true,
    gated: false,
  }),
  // This device's own, for its first run: no peer reads it.
  invoke("repos", VoidSchema, TerrierReposSchema, {
    remote: false,
    gated: false,
  }),
);
