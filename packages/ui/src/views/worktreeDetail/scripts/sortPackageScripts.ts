import { assertNever } from "../../../lib/utils.ts";
import { byUsage } from "../../../lib/sortProjects.ts";
import type {
  PackageScriptSortMode,
  PackageScriptUsage,
} from "@shigomori/contracts/schemas";

export interface SortableEntry {
  name: string;
  command: string;
}

const byName = (a: SortableEntry, b: SortableEntry) =>
  a.name.localeCompare(b.name);

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
      // the last arrange, or never arranged) in file order.
      const rank = new Map(order.map((name, i) => [name, i]));
      const unranked = order.length;
      return mapped.toSorted(
        (a, b) =>
          (rank.get(a.name) ?? unranked) - (rank.get(b.name) ?? unranked),
      );
    }
    case "alphabetical":
      return mapped.toSorted(byName);
    case "recent":
      return mapped.toSorted(
        byUsage("lastUsed", (entry) => usage[entry.name], byName),
      );
    case "frequent":
      return mapped.toSorted(
        byUsage("recentCount", (entry) => usage[entry.name], byName),
      );
    default:
      return assertNever(mode);
  }
}

// The scripts pinned to the launch row, in list order. Pins only count
// under the "manual" sort, and null means there are none here (or only
// another branch's), which leaves the row to show as many as fit.
export function pinnedEntries(
  sorted: SortableEntry[],
  mode: PackageScriptSortMode,
  launchRow: readonly string[],
): SortableEntry[] | null {
  if (mode !== "manual") return null;
  const pinned = new Set(launchRow);
  const onRow = sorted.filter((entry) => pinned.has(entry.name));
  return onRow.length > 0 ? onRow : null;
}
