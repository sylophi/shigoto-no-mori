import { ArrowDownUp } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PackageScriptSortMode } from "@shared/schemas";

const SORT_OPTIONS: ReadonlyArray<{
  value: PackageScriptSortMode;
  label: string;
}> = [
  { value: "frequent", label: "Most used" },
  { value: "recent", label: "Most recently used" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "manifest", label: "package.json" },
];

export function SortMenu({
  value,
  onChange,
}: {
  value: PackageScriptSortMode;
  onChange: (mode: PackageScriptSortMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Sort scripts"
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <ArrowDownUp aria-hidden className="size-3" />
        <span>Sort</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => onChange(v as PackageScriptSortMode)}
        >
          {SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
