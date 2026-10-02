// The Visitors section's model: every device's tally of who has visited
// (cli/visitors.go) added up into one guest book, and the album it
// fills, a slot for every character and a sticker in it once they
// have come by. Pure, so test/villager-visitors.mts drives it under
// plain Node.
import type {
  VillagerProfile,
  VillagerProfiles,
  VisitorTally,
} from "@shared/schemas";
import { type VillagerRarity, villagerRarity } from "@shared/villagers/rarity";

// One device's tally, as read off it.
export interface DeviceTally {
  deviceId: string;
  label: string;
  tally: VisitorTally;
}

// A villager's visits on every device together. `first` and `last` are
// epoch ms, `warmth` the friendship as it stood when read (each device
// reports its own cooled to then). `byDevice` names where they came,
// most visits first.
export interface Visits {
  count: number;
  first: number;
  last: number;
  warmth: number;
  byDevice: { deviceId: string; label: string; count: number }[];
}

// Every device's tally added up. Warmth adds up too: a visit warms the
// friendship wherever it happened.
export function mergeTallies(tallies: readonly DeviceTally[]) {
  const merged = new Map<string, Visits>();
  for (const { deviceId, label, tally } of tallies) {
    for (const [slug, visits] of Object.entries(tally)) {
      const held = merged.get(slug);
      const here = { deviceId, label, count: visits.count };
      if (held === undefined) {
        merged.set(slug, { ...visits, byDevice: [here] });
        continue;
      }
      held.count += visits.count;
      held.first = Math.min(held.first, visits.first);
      held.last = Math.max(held.last, visits.last);
      held.warmth += visits.warmth;
      held.byDevice.push(here);
    }
  }
  for (const visits of merged.values()) {
    visits.byDevice.sort((a, b) => b.count - a.count);
  }
  return merged;
}

// How close a villager is now: five hearts, read off their warmth,
// which each visit adds one to and which halves every 60 days without
// one (cli/visitors.go). A heart comes with the first visit, more fill
// as they keep coming, and they empty again as the friendship cools:
// one visit alone fades out in about three and a half months.
export const FRIENDSHIP = [
  { from: 0.3, title: "Acquaintance" },
  { from: 1.5, title: "Neighbor" },
  { from: 2.5, title: "Friend" },
  { from: 4, title: "Good pal" },
  { from: 6, title: "Kindred spirit" },
] as const;

export function friendshipOf(warmth: number): {
  hearts: number;
  title: string;
} {
  let hearts = 0;
  for (const [index, level] of FRIENDSHIP.entries()) {
    if (warmth >= level.from) hearts = index + 1;
  }
  return { hearts, title: FRIENDSHIP[hearts - 1]?.title ?? "Drifted apart" };
}

// A slot in the album: every character has one, filled once they have
// visited.
export interface AlbumEntry {
  slug: string;
  profile: VillagerProfile;
  rarity: VillagerRarity;
  visits: Visits | null;
}

export type VisitorSort = "closest" | "visits" | "recent" | "name";

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
    if (sort === "closest") {
      return b.visits.warmth - a.visits.warmth || byName(a, b);
    }
    if (sort === "visits") {
      return b.visits.count - a.visits.count || byName(a, b);
    }
    if (sort === "recent") return b.visits.last - a.visits.last;
    return byName(a, b);
  });
}

export interface Album {
  // Rarest first, the order the page shows them.
  sections: Record<VillagerRarity, AlbumEntry[]>;
  // How many of each section have visited.
  met: Record<VillagerRarity, number>;
  // Everyone who has visited, for the guest book.
  visited: AlbumEntry[];
  // The one met most (bestFriendOf), and the newest face.
  bestFriend: AlbumEntry | null;
  newest: AlbumEntry | null;
  total: number;
  visits: number;
}

// Every character the villager data knows, each with their visits or
// none. A tally entry for a name the data doesn't know is left out: no
// face, nothing to show.
export function buildAlbum(
  profiles: VillagerProfiles,
  merged: ReadonlyMap<string, Visits>,
): Album {
  const sections: Album["sections"] = { legendary: [], rare: [], common: [] };
  const met: Album["met"] = { legendary: 0, rare: 0, common: 0 };
  const visited: AlbumEntry[] = [];
  let visits = 0;
  for (const [slug, profile] of Object.entries(profiles)) {
    const entry: AlbumEntry = {
      slug,
      profile,
      rarity: villagerRarity(slug, profile),
      visits: merged.get(slug) ?? null,
    };
    sections[entry.rarity].push(entry);
    if (entry.visits !== null) {
      met[entry.rarity] += 1;
      visited.push(entry);
      visits += entry.visits.count;
    }
  }
  return {
    sections,
    met,
    visited,
    bestFriend: bestFriendOf(visited),
    newest: newestOf(visited),
    total: Object.keys(profiles).length,
    visits,
  };
}

// The best friend: the one villager met most, and of two met as often,
// the closer now, then the one seen last. Null while nobody has come.
export function bestFriendOf(
  visited: readonly AlbumEntry[],
): AlbumEntry | null {
  let best: AlbumEntry | null = null;
  for (const entry of visited) {
    const visits = entry.visits;
    const held = best?.visits;
    if (visits === null) continue;
    if (
      held == null ||
      visits.count > held.count ||
      (visits.count === held.count &&
        (visits.warmth > held.warmth ||
          (visits.warmth === held.warmth && visits.last > held.last)))
    ) {
      best = entry;
    }
  }
  return best;
}

// The newest face: whoever first came last.
export function newestOf(visited: readonly AlbumEntry[]): AlbumEntry | null {
  let newest: AlbumEntry | null = null;
  for (const entry of visited) {
    const first = entry.visits?.first;
    const latest = newest?.visits?.first;
    if (first !== undefined && (latest === undefined || first > latest)) {
      newest = entry;
    }
  }
  return newest;
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
