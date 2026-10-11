import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, Plus, Search, X } from "lucide-react";
import { IconButton } from "../../primitives/icon-button.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { rankByScore } from "../../lib/fuzzyMatch.ts";

export interface PickerOption {
  value: string;
  // What the search matches beside the value (a person's name, a
  // label's description).
  detail?: string | null;
  // Leads the row and the chip as a dot: a label's color, hex without
  // the hash as GitHub stores it.
  color?: string;
}

function Mark({ color }: { color: string | undefined }) {
  if (color === undefined) return null;
  return (
    <span
      aria-hidden
      className="size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: `#${color}` }}
    />
  );
}

// Several of a list picked, the way GitHub's sidebar picks reviewers,
// assignees and labels: the picked ones as chips, and a search over the
// rest behind the button that adds one. The search ranks by the value
// and the detail alike.
export function MultiPickerView({
  label,
  options,
  value,
  onChange,
  loading,
  empty,
  disabled,
}: {
  label: string;
  options: readonly PickerOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  loading: boolean;
  // What the list says when there's nothing to pick.
  empty: string;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const ranked = rankByScore(query, [...options], (option) =>
    option.detail ? `${option.value} ${option.detail}` : option.value,
  );
  const byValue = new Map(options.map((option) => [option.value, option]));

  return (
    <div className="space-y-1.5">
      <Combobox.Root
        multiple
        value={[...value]}
        onValueChange={(next) => onChange(next as string[])}
        inputValue={query}
        onInputValueChange={setQuery}
        onOpenChange={(open) => {
          if (open) setQuery("");
        }}
        disabled={disabled}
        autoHighlight
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{label}</span>
          <Combobox.Trigger
            aria-label={`Add ${label.toLowerCase()}`}
            render={<IconButton className="ml-auto" />}
          >
            <Plus aria-hidden className="size-3.5" />
          </Combobox.Trigger>
        </div>
        <Combobox.Portal>
          <Combobox.Positioner
            sideOffset={4}
            side="bottom"
            align="end"
            className="z-50"
          >
            <Combobox.Popup
              data-slot="combobox-popup"
              className="flex max-h-72 w-64 flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
            >
              <div
                data-slot="search-row"
                className="flex items-center gap-2 border-b border-border px-3"
              >
                <Search
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                />
                <Combobox.Input
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className="flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <Combobox.List className="flex-1 overflow-y-auto p-1">
                {ranked.length === 0 && (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {loading
                      ? "Loading…"
                      : options.length === 0
                        ? empty
                        : "No matches."}
                  </div>
                )}
                {ranked.map((option) => (
                  <Combobox.Item
                    key={option.value}
                    value={option.value}
                    className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <Combobox.ItemIndicator>
                        <Check aria-hidden className="size-3.5" />
                      </Combobox.ItemIndicator>
                    </span>
                    <Mark color={option.color} />
                    <span className="min-w-0 flex-1 truncate">
                      {option.value}
                      {option.detail && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {option.detail}
                        </span>
                      )}
                    </span>
                  </Combobox.Item>
                ))}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">None</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {value.map((picked) => (
            <li
              key={picked}
              className="flex max-w-full items-center gap-1 rounded-md bg-muted/60 py-0.5 pr-0.5 pl-1.5 text-xs"
            >
              <Mark color={byValue.get(picked)?.color} />
              <SimpleTooltip whenTruncated tip={picked}>
                <span className="min-w-0 truncate">{picked}</span>
              </SimpleTooltip>
              <IconButton
                aria-label={`Remove ${picked}`}
                tone="destructive"
                className="p-0.5"
                disabled={disabled}
                onClick={() => onChange(value.filter((v) => v !== picked))}
              >
                <X aria-hidden className="size-3" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
