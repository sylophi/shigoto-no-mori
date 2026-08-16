import { ArrowDownUp } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

interface SortMenuProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SortOption<T>>;
  // What the control sorts, for the accessible name -- "Sort scripts",
  // "Sort worktrees". The visible trigger text is `label`.
  ariaLabel: string;
  // Defaults to the bare word, which is all the scripts list has room
  // for. Pass the selected option's label where the width exists and
  // the current order is worth stating.
  label?: string;
  triggerClassName?: string;
}

// The "sort this list by" dropdown, wherever a list offers one. One
// component rather than a per-list copy so the trigger keeps a single
// data-slot for doubutsu to hook and a single class string to restyle.
export function SortMenu<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  label = "Sort",
  triggerClassName,
}: SortMenuProps<T>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="sort-menu-trigger"
        aria-label={ariaLabel}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 data-popup-open:bg-accent data-popup-open:text-foreground",
          triggerClassName,
        )}
      >
        <ArrowDownUp aria-hidden className="size-3" />
        <span>{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
