import * as Schema from "effect/Schema";

// One published release of the app, as the changelog shows it. The
// GitHub release list is the source (shared/releases.ts): `version`
// is the tag without its leading "v", `notes` the release body as
// written (markdown, with the odd raw <img>), `url` its page on GitHub.
export const ReleaseSchema = Schema.Struct({
  version: Schema.String,
  notes: Schema.String,
  // ISO 8601, or null for a release GitHub gave no date.
  publishedAt: Schema.NullOr(Schema.String),
  prerelease: Schema.Boolean,
  url: Schema.String,
});
export type Release = typeof ReleaseSchema.Type;
