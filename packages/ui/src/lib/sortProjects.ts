import type { ProjectSortMode } from "@shigomori/contracts/schemas";

interface Usage {
  readonly lastUsed?: number;
  readonly recentCount?: number;
}

// The sidebar's project order, over anything that stands for a project
// (a peer-only project among the local ones) so the tree sorts its
// groups by the one rule. `manual` keeps the stored (drag-arranged)
// order.
export function sortByProject<T>(
  items: readonly T[],
  mode: ProjectSortMode,
  projectOf: (item: T) => Usage & { readonly name: string },
): readonly T[] {
  if (mode === "manual") return items;
  return sortByUsage(items, mode, (item) => projectOf(item).name, projectOf);
}

// By name, or most-used first by one usage figure with ties by name:
// the orders projects and package.json scripts share.
export function sortByUsage<T>(
  items: readonly T[],
  mode: "alphabetical" | "recent" | "frequent",
  nameOf: (item: T) => string,
  usageOf: (item: T) => Usage | undefined,
): T[] {
  const field = mode === "recent" ? "lastUsed" : "recentCount";
  return items.toSorted((a, b) => {
    const diff =
      mode === "alphabetical"
        ? 0
        : (usageOf(b)?.[field] ?? 0) - (usageOf(a)?.[field] ?? 0);
    return diff !== 0 ? diff : nameOf(a).localeCompare(nameOf(b));
  });
}
