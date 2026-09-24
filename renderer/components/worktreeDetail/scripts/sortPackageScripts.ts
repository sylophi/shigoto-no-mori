import { assertNever } from "@/lib/utils";
import type {
  PackageScriptSortMode,
  PackageScriptUsage,
} from "@shared/schemas";

export interface SortableEntry {
  name: string;
  command: string;
}

export function sortEntries(
  entries: ReadonlyArray<[string, string]>,
  mode: PackageScriptSortMode,
  usage: Record<string, PackageScriptUsage>,
  order: readonly string[],
): SortableEntry[] {
  const mapped: SortableEntry[] = entries.map(([name, command]) => ({
    name,
    command,
  }));
  switch (mode) {
    case "manifest":
      return mapped;
    case "manual": {
      // Named scripts in their stored places, then the rest (added since
      // the last arrange, or never arranged) in package.json order.
      const rank = new Map(order.map((name, i) => [name, i]));
      const unranked = order.length;
      return mapped.toSorted(
        (a, b) =>
          (rank.get(a.name) ?? unranked) - (rank.get(b.name) ?? unranked),
      );
    }
    case "alphabetical":
      return mapped.toSorted((a, b) => a.name.localeCompare(b.name));
    case "recent":
      return mapped.toSorted((a, b) => {
        const diff =
          (usage[b.name]?.lastUsed ?? 0) - (usage[a.name]?.lastUsed ?? 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    case "frequent":
      return mapped.toSorted((a, b) => {
        const diff =
          (usage[b.name]?.recentCount ?? 0) - (usage[a.name]?.recentCount ?? 0);
        return diff !== 0 ? diff : a.name.localeCompare(b.name);
      });
    default:
      return assertNever(mode);
  }
}
