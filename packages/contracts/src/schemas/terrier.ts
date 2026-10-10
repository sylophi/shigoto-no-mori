import * as Schema from "effect/Schema";

// Whether the terrier integration can light up: the binary on PATH,
// and `terrier ls --json` answering in the shape the CLI reads
// (host/lib/terrier.ts probes it for Settings).
export const TerrierReadinessSchema = Schema.Struct({
  installed: Schema.Boolean,
  readable: Schema.Boolean,
});
export type TerrierReadiness = typeof TerrierReadinessSchema.Type;

// The repos terrier lists, for the first run's project step, which
// offers them whether or not this device lists them as projects yet.
export const TerrierReposSchema = Schema.Array(
  Schema.Struct({ name: Schema.String, path: Schema.String }),
);
export type TerrierRepos = typeof TerrierReposSchema.Type;
