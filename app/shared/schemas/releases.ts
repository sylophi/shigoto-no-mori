import { z } from "zod";

// One published release of the app, as the changelog shows it. The
// GitHub release list is the source (shared/releases.ts): `version`
// is the tag without its leading "v", `notes` the release body as
// written (markdown, with the odd raw <img>), `url` its page on GitHub.
export const ReleaseSchema = z.object({
  version: z.string(),
  notes: z.string(),
  // ISO 8601, or null for a release GitHub gave no date.
  publishedAt: z.string().nullable(),
  prerelease: z.boolean(),
  url: z.string(),
});
export type Release = z.infer<typeof ReleaseSchema>;
