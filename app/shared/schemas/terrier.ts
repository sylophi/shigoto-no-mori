import { z } from "zod";

// Whether the terrier integration can light up: the binary on PATH,
// and its version inside the minor-version handshake this build
// understands (see host/lib/terrier.ts). `version` is whatever
// `terrier version` printed, for the Settings row to name when the
// handshake fails. Absent when the binary is missing.
export const TerrierReadinessSchema = z.object({
  installed: z.boolean(),
  compatible: z.boolean(),
  version: z.string().optional(),
});
export type TerrierReadiness = z.infer<typeof TerrierReadinessSchema>;
