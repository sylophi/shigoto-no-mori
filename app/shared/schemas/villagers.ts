import { z } from "zod";

// The villager data a device holds: each doubutsu villager's face and
// profile, downloaded from Nookipedia when the user asks and served
// from the device's data dir from then on (host/lib/villagers.ts).

// A villager's name slug, as in the worktree name pool: plain
// kebab-case, so it is also safe as a file name.
export const VillagerSlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

const CountSchema = z.number().int().nonnegative();

export const VillagerDataStatusSchema = z.discriminatedUnion("kind", [
  // Nothing downloaded. How many villagers a download brings.
  z.object({
    kind: z.literal("absent"),
    villagers: CountSchema,
  }),
  // A download is running. A villager counts once both its profile
  // and its face are stored.
  z.object({
    kind: z.literal("downloading"),
    done: CountSchema,
    villagers: CountSchema,
  }),
  // Downloaded, all of it, and when (an ISO timestamp).
  z.object({
    kind: z.literal("ready"),
    downloadedAt: z.string(),
    villagers: CountSchema,
  }),
  // A download that stopped before the end, on an error or with the
  // app closing. What it stored is kept, so the next one resumes.
  z.object({
    kind: z.literal("failed"),
    done: CountSchema,
    villagers: CountSchema,
    message: z.string(),
  }),
]);
export type VillagerDataStatus = z.infer<typeof VillagerDataStatusSchema>;

export const VillagerKindSchema = z.enum(["villager", "special"]);
export type VillagerKind = z.infer<typeof VillagerKindSchema>;

// What the villager's wiki page says about them, as far as it does:
// every field but the name, the kind and the page is left out when the
// page lacks it.
export const VillagerProfileSchema = z.object({
  name: z.string().min(1),
  kind: VillagerKindSchema,
  species: z.string().optional(),
  personality: z.string().optional(),
  gender: z.string().optional(),
  // MM-DD.
  birthday: z
    .string()
    .regex(/^\d{2}-\d{2}$/)
    .optional(),
  // The star sign.
  sign: z.string().optional(),
  catchphrase: z.string().optional(),
  quote: z.string().optional(),
  japaneseName: z.string().optional(),
  japaneseNameRomaji: z.string().optional(),
  // The villager's Nookipedia page.
  url: z.string(),
});
export type VillagerProfile = z.infer<typeof VillagerProfileSchema>;

export const VillagerProfilesSchema = z.record(
  VillagerSlugSchema,
  VillagerProfileSchema,
);
export type VillagerProfiles = z.infer<typeof VillagerProfilesSchema>;
