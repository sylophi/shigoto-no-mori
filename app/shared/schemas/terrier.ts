import { z } from "zod";

// Whether the terrier integration can light up: the binary on PATH,
// and `terrier ls --json` answering in the shape the CLI reads
// (host/lib/terrier.ts probes it for Settings).
export const TerrierReadinessSchema = z.object({
  installed: z.boolean(),
  readable: z.boolean(),
});
export type TerrierReadiness = z.infer<typeof TerrierReadinessSchema>;
