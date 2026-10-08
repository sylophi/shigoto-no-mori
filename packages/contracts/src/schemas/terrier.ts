import * as Schema from "effect/Schema";

// Whether the terrier integration can light up: the binary on PATH,
// and its version inside the minor-version handshake this build
// understands (host/lib/terrier.ts probes it for Settings). `version` is whatever
// `terrier version` printed, for the Settings row to name when the
// handshake fails. Absent when the binary is missing.
export const TerrierReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  compatible: Schema.Boolean,
  version: Schema.optional(Schema.String),
});
export type TerrierReadiness = typeof TerrierReadinessSchema.Type;
