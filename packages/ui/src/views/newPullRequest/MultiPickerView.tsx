import { noMatch } from "@shigomori/contracts/words";
import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, Plus, X } from "lucide-react";
import {
  ComboboxEmpty,
  ComboboxItem,
  ComboboxPopup,
} from "../../primitives/combobox.tsx";
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
        <ComboboxPopup
          placeholder={`Search ${label.toLowerCase()}…`}
          align="end"
          className="w-64"
        >
          {ranked.length === 0 && (
            <ComboboxEmpty>
              {loading
                ? "Loading…"
                : options.length === 0
                  ? empty
                  : noMatch(label.toLowerCase())}
            </ComboboxEmpty>
          )}
          {ranked.map((option) => (
            <ComboboxItem key={option.value} value={option.value}>
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
            </ComboboxItem>
          ))}
        </ComboboxPopup>
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
