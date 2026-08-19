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
// read left to right, widening from "everything" to the narrowest cuts,
// and that order is the control's design rather than an accident of how
// the type was declared.
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
  {
    value: "safe",
    label: "Safe",
    title: "Already merged or absorbed into the primary branch, and clean",
  },
];

const MODES: ReadonlyArray<SegmentedOption<"survey" | "tidy">> = [
  { value: "survey", label: "Survey", title: "Read the state of everything" },
  {
    value: "tidy",
    label: "Tidy",
    title: "Measure disk use and pick worktrees to remove",
  },
];

// "Size on disk" is only offered while tidying, because that is the only
// time the sizes exist. Offering it in survey mode would sort every row
// by zero and quietly fall through to the branch-name tiebreaker, and
// since the sort persists you'd get that dead order back on your next
// visit. "Safest to remove" needs only the hygiene verdicts, which load
// either way, so it stays.
const SURVEY_SORTS: ReadonlyArray<SortOption<ForestSort>> = [
  { value: "activity", label: FOREST_SORT_LABELS.activity },
  { value: "age", label: FOREST_SORT_LABELS.age },
  { value: "branch", label: FOREST_SORT_LABELS.branch },
  { value: "tidiest", label: FOREST_SORT_LABELS.tidiest },
];

const TIDY_SORTS: ReadonlyArray<SortOption<ForestSort>> = [
  ...SURVEY_SORTS,
  { value: "size", label: FOREST_SORT_LABELS.size },
];

interface ForestToolbarProps {
  facet: ForestFacet;
  onFacetChange: (facet: ForestFacet) => void;
  sort: ForestSort;
  onSortChange: (sort: ForestSort) => void;
  query: string;
  onQueryChange: (query: string) => void;
  counts: Record<ForestFacet, number>;
  tidying: boolean;
  onTidyingChange: (tidying: boolean) => void;
  // Right-hand status while tidying, where the sort control's own count
  // would otherwise sit. Absent while surveying.
  selectionLabel: string | undefined;
  disabled?: boolean;
}

// Two rows of visible controls above the list, no chrome hidden in the
// header. Row one is what you're doing, row two is what you're looking
// at, and both keep the same left-heavy, count-on-the-right rhythm the
// list and the action block below repeat.
export function ForestToolbar({
  facet,
  onFacetChange,
  sort,
  onSortChange,
  query,
  onQueryChange,
  counts,
  tidying,
  onTidyingChange,
  selectionLabel,
  disabled,
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="relative min-w-40 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground/60"
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
            className="w-full py-1.5 pr-2.5 pl-8"
          />
        </div>
        <SegmentedControl<"survey" | "tidy">
          value={tidying ? "tidy" : "survey"}
          onChange={(next) => onTidyingChange(next === "tidy")}
          options={MODES}
          aria-label="Forest mode"
          optionClassName="px-3 py-1.5 text-xs"
          disabled={disabled}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <SegmentedControl
          value={facet}
          onChange={onFacetChange}
          options={facetOptions}
          aria-label="Show worktrees"
          optionClassName="gap-1.5 px-2.5 py-1 text-xs"
          disabled={disabled}
        />
        <div className="flex shrink-0 items-center gap-3">
          {selectionLabel && (
            <span className="text-xs text-muted-foreground">
              {selectionLabel}
            </span>
          )}
          <SortMenu
            value={sort}
            onChange={onSortChange}
            options={tidying ? TIDY_SORTS : SURVEY_SORTS}
            ariaLabel="Sort worktrees"
            label={FOREST_SORT_LABELS[sort]}
            triggerClassName="py-1 text-xs"
          />
        </div>
      </div>
    </div>
  );
}
