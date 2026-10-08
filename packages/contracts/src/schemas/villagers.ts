import * as Schema from "effect/Schema";

// The villager data a device holds: each doubutsu villager's face and
// profile, downloaded from Nookipedia when the user asks and served
// from the device's data dir from then on (host/lib/villagers.ts).

// A villager's name slug, as in the worktree name pool: plain
// kebab-case, so it is also safe as a file name.
export const VillagerSlugSchema = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
);

export const VillagerDataStatusSchema = Schema.Union([
  // Nothing downloaded. How many villagers a download brings.
  Schema.Struct({
    kind: Schema.Literal("absent"),
    villagers: Schema.Natural,
  }),
  // A download is running. A villager counts once both its profile
  // and its face are stored.
  Schema.Struct({
    kind: Schema.Literal("downloading"),
    done: Schema.Natural,
    villagers: Schema.Natural,
  }),
  // Downloaded, all of it, and when (an ISO timestamp).
  Schema.Struct({
    kind: Schema.Literal("ready"),
    downloadedAt: Schema.String,
    villagers: Schema.Natural,
  }),
  // A download that stopped before the end, on an error or with the
  // app closing. What it stored is kept, so the next one resumes.
  Schema.Struct({
    kind: Schema.Literal("failed"),
    done: Schema.Natural,
    villagers: Schema.Natural,
    message: Schema.String,
  }),
]);
export type VillagerDataStatus = typeof VillagerDataStatusSchema.Type;

const VillagerKindSchema = Schema.Literals(["villager", "special"]);
export type VillagerKind = typeof VillagerKindSchema.Type;

// What the villager's wiki page says about them, as far as it does:
// every field but the name, the kind and the page is left out when the
// page lacks it.
export const VillagerProfileSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  kind: VillagerKindSchema,
  species: Schema.optional(Schema.String),
  personality: Schema.optional(Schema.String),
  gender: Schema.optional(Schema.String),
  // MM-DD.
  birthday: Schema.optional(
    Schema.String.check(Schema.isPattern(/^\d{2}-\d{2}$/)),
  ),
  // The star sign.
  sign: Schema.optional(Schema.String),
  catchphrase: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
  japaneseName: Schema.optional(Schema.String),
  japaneseNameRomaji: Schema.optional(Schema.String),
  // The villager's Nookipedia page.
  url: Schema.String,
});
export type VillagerProfile = typeof VillagerProfileSchema.Type;

// A key that is not a slug fails the whole record rather than being
// left out.
export const VillagerProfilesSchema = Schema.Record(
  Schema.String,
  VillagerProfileSchema,
).check(Schema.isPropertyNames(VillagerSlugSchema));
export type VillagerProfiles = typeof VillagerProfilesSchema.Type;
