import * as Schema from "effect/Schema";

// Whether the terrier integration can light up: the binary on PATH,
// and `terrier ls --json` answering in the shape the CLI reads
// (host/lib/terrier.ts probes it for Settings).
export const TerrierReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  readable: Schema.Boolean,
});
export type TerrierReadiness = typeof TerrierReadinessSchema.Type;
