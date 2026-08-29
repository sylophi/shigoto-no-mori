import { z } from "zod";
import { invoke } from "@shared/ipc/contract";
import { TerrierReadinessSchema } from "@shared/schemas";

export const terrierContract = {
  readiness: invoke("terrier:readiness", z.void(), TerrierReadinessSchema),
} as const;
