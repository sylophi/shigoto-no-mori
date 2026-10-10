// The Visitors section's model: the visit log (visitLog.ts) tallied by
// villager, and the album it fills, a slot for every character and a
// sticker in it once they have come by. Pure, so
// test/villager-visitors.mts drives it under plain Node.
import type {
  VillagerProfile,
  VillagerProfiles,
} from "@shigomori/contracts/schemas";
import {
  type VillagerRarity,
  villagerRarity,
} from "@shigomori/ui/lib/villagers/rarity.ts";
import type { VisitLog } from "./visitLog";

// A villager's visits: how many, and the first and last (epoch ms).
export interface Visits {
  count: number;
  first: number;
  last: number;
}

// Visits from `since` on (epoch ms): the album started over then.
export function tallyVisits(log: VisitLog, since = 0): Map<string, Visits> {
  const tally = new Map<string, Visits>();
  for (const visit of Object.values(log)) {
    if (visit === null || visit.at < since) continue;
    const held = tally.get(visit.slug);
    if (held === undefined) {
      tally.set(visit.slug, { count: 1, first: visit.at, last: visit.at });
      continue;
    }
    held.count += 1;
    held.first = Math.min(held.first, visit.at);
    held.last = Math.max(held.last, visit.at);
  }
  return tally;
}

// A slot in the album: every character has one, filled once they have
// visited.
export interface AlbumEntry {
  slug: string;
  profile: VillagerProfile;
  rarity: VillagerRarity;
  visits: Visits | null;
}

export type VisitorSort = "visits" | "recent" | "name";

const NAMES = new Intl.Collator();
const byName = (a: AlbumEntry, b: AlbumEntry) =>
  NAMES.compare(a.profile.name, b.profile.name);

// Visited first, in the sort's order, then the empty slots by name.
export function sortAlbum(
  entries: readonly AlbumEntry[],
  sort: VisitorSort,
): AlbumEntry[] {
  return entries.toSorted((a, b) => {
    if (a.visits === null || b.visits === null) {
      if (a.visits !== b.visits) return a.visits === null ? 1 : -1;
      return byName(a, b);
    }
    if (sort === "visits") {
      return b.visits.count - a.visits.count || byName(a, b);
    }
    if (sort === "recent") return b.visits.last - a.visits.last;
    return byName(a, b);
  });
}

// An album slot someone has filled.
export type VisitedEntry = AlbumEntry & { visits: Visits };

export interface Album {
  // Rarest first, the order the page shows them.
  sections: Record<VillagerRarity, AlbumEntry[]>;
  // How many of each section have visited, and of everyone.
  met: Record<VillagerRarity, number>;
  metTotal: number;
  // The one met most, and of two met as often the one seen last, and
  // the newest face (whoever first came last). Null while nobody has.
  bestFriend: VisitedEntry | null;
  newest: VisitedEntry | null;
  total: number;
  visits: number;
}

// Every character the villager data knows, each with their visits or
// none. A tally entry for a name the data doesn't know is left out: no
// face, nothing to show.
export function buildAlbum(
  profiles: VillagerProfiles,
  tally: ReadonlyMap<string, Visits>,
): Album {
  const sections: Album["sections"] = { legendary: [], rare: [], common: [] };
  const met: Album["met"] = { legendary: 0, rare: 0, common: 0 };
  let bestFriend: VisitedEntry | null = null;
  let newest: VisitedEntry | null = null;
  let metTotal = 0;
  let visits = 0;
  for (const [slug, profile] of Object.entries(profiles)) {
    const entry: AlbumEntry = {
      slug,
      profile,
      rarity: villagerRarity(slug, profile),
      visits: tally.get(slug) ?? null,
    };
    sections[entry.rarity].push(entry);
    if (entry.visits === null) continue;
    const visited = entry as VisitedEntry;
    met[entry.rarity] += 1;
    metTotal += 1;
    visits += visited.visits.count;
    const best = bestFriend?.visits;
    if (
      best === undefined ||
      visited.visits.count > best.count ||
      (visited.visits.count === best.count && visited.visits.last > best.last)
    ) {
      bestFriend = visited;
    }
    if (newest === null || visited.visits.first > newest.visits.first) {
      newest = visited;
    }
  }
  return {
    sections,
    met,
    metTotal,
    bestFriend,
    newest,
    total: Object.keys(profiles).length,
    visits,
  };
}

// How long a first visit stays news: the sticker wears "New!".
const NEW_FOR_MS = 7 * 24 * 60 * 60_000;

export function isNewVisitor(visits: Visits, now: number): boolean {
  return now - visits.first < NEW_FOR_MS;
}

// "once", "3 times".
export function visitedTimes(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

// "Mar 16, 2026".
export function visitDate(at: number): string {
  return DATE.format(at);
}

// A small lean per sticker, the same every render, so the album looks
// stuck in by hand: -3 to 3 degrees, read off the slug.
export function stickerTilt(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 7) - 3;
}
