import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { TerrierReadinessSchema } from "@shared/schemas";

export const terrierContract = defineContract("host", {
  readiness: invoke("terrier:readiness", z.void(), TerrierReadinessSchema, {
    remote: true,
    mutating: false,
  }),
});
