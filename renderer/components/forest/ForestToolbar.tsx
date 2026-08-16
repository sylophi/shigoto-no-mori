import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/ui/segmented-control";
import { SortMenu, type SortOption } from "@/components/ui/sort-menu";
import type { ForestSort } from "@shared/schemas";
import { FOREST_SORT_LABELS, type ForestFacet } from "./forestFilters";

// Ordered, not a Record keyed by facet: this is the order the segments
// read left to right, widening from "everything" to the two narrowest
// cuts, and that order is the control's design rather than an accident
// of how the type was declared.
const FACETS: ReadonlyArray<{
  value: ForestFacet;
  label: string;
  title: string;
}> = [
  { value: "all", label: "All", title: "Every worktree in every project" },
  {
    value: "attention",
    label: "Attention",
    title:
      "Uncommitted changes, commits to push or pull, a divergence, or a closed pull request",
  },
  { value: "dirty", label: "Dirty", title: "Uncommitted changes on disk" },
  { value: "pullRequest", label: "PR", title: "Branch has a pull request" },
];

// Listed rather than derived from the label map's key order: the menu
// reads best default-first, and that's a claim about the menu, not about
// how the type was declared.
const SORT_OPTIONS: ReadonlyArray<SortOption<ForestSort>> = [
  { value: "activity", label: FOREST_SORT_LABELS.activity },
  { value: "age", label: FOREST_SORT_LABELS.age },
  { value: "branch", label: FOREST_SORT_LABELS.branch },
];

interface ForestToolbarProps {
  facet: ForestFacet;
  onFacetChange: (facet: ForestFacet) => void;
  sort: ForestSort;
  onSortChange: (sort: ForestSort) => void;
  query: string;
  onQueryChange: (query: string) => void;
  counts: Record<ForestFacet, number>;
}

export function ForestToolbar({
  facet,
  onFacetChange,
  sort,
  onSortChange,
  query,
  onQueryChange,
  counts,
}: ForestToolbarProps) {
  const facetOptions: SegmentedOption<ForestFacet>[] = FACETS.map((option) => ({
    value: option.value,
    title: option.title,
    label: (
      <>
        {option.label}
        <span className="tabular text-[10px] opacity-60">
          {counts[option.value]}
        </span>
      </>
    ),
  }));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-40 flex-1">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/60"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          // Escape clears rather than blurring: the field is the only
          // thing holding the list narrow, so "get me back to the whole
          // forest" is the one action worth a key.
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              onQueryChange("");
            }
          }}
          placeholder="Filter by branch, folder, or project…"
          aria-label="Filter worktrees"
          className="w-full py-1 pr-2.5 pl-7 text-xs"
        />
      </div>

      <SegmentedControl
        value={facet}
        onChange={onFacetChange}
        options={facetOptions}
        aria-label="Show worktrees"
        optionClassName="gap-1.5 px-2.5 py-1 text-xs"
      />

      {/* Names the current order rather than saying "Sort": the header
          is already claiming a line, and which way the forest is
          ordered changes what you conclude from scanning it. */}
      <SortMenu
        value={sort}
        onChange={onSortChange}
        options={SORT_OPTIONS}
        ariaLabel="Sort worktrees"
        label={FOREST_SORT_LABELS[sort]}
        triggerClassName="py-1 text-xs"
      />
    </div>
  );
}
