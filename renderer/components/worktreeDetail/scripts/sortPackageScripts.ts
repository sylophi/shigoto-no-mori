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
): SortableEntry[] {
  const mapped: SortableEntry[] = entries.map(([name, command]) => ({
    name,
    command,
  }));
  switch (mode) {
    case "manifest":
      return mapped;
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
