import type { VillagerProfile } from "@shared/schemas";

// Every doubutsu character has a rarity, like a card's, and the
// villager extras scale their flair with it (DESIGN.md, "Village life:
// rarity"). Regular villagers are common, special characters rare, and
// the household names below legendary. Rare follows the downloaded
// profile's kind. Legendary is picked by hand and holds names only.
export type VillagerRarity = "common" | "rare" | "legendary";

export const LEGENDARY_VILLAGERS: readonly string[] = [
  "tom-nook",
  "isabelle",
  "kk-slider",
  "timmy",
  "tommy",
  "blathers",
  "celeste",
  "mr-resetti",
  "redd",
  "brewster",
  "kappn",
  "pascal",
];

const legendary = new Set(LEGENDARY_VILLAGERS);

export function villagerRarity(
  slug: string,
  profile: Pick<VillagerProfile, "kind">,
): VillagerRarity {
  if (legendary.has(slug)) return "legendary";
  return profile.kind === "special" ? "rare" : "common";
}
