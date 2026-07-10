import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { rankByScore } from "@/lib/fuzzyMatch";
import { queryKeys } from "@/lib/queryKeys";
import { useBranches } from "@/hooks/git/useBranches";
import type { BranchList } from "@shared/schemas";

interface BranchComboboxProps {
  projectId: string | null;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  // Free-text "Use as ref" entries are NOT filtered.
  excludeBranches?: readonly string[];
}

export interface BranchEntry {
  name: string;
  kind: "local" | "remote";
}

function toBranchEntries(
  branches: BranchList | undefined,
  exclude: ReadonlySet<string>,
): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const name of branches?.local ?? []) {
    if (!exclude.has(name)) out.push({ name, kind: "local" });
  }
  for (const name of branches?.remote ?? []) {
    if (!exclude.has(name)) out.push({ name, kind: "remote" });
  }
  return out;
}

export function BranchCombobox({
  projectId,
  value,
  onChange,
  placeholder,
  id,
  disabled,
  className,
  excludeBranches,
}: BranchComboboxProps) {
  const { data: branches, isFetching } = useBranches(projectId);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const all = toBranchEntries(branches, new Set(excludeBranches ?? []));
  const sorted = rankByScore(query, all, (b) => b.name);

  const trimmedQuery = query.trim();
  const showCustom =
    trimmedQuery.length > 0 && !all.some((b) => b.name === trimmedQuery);

  return (
    <Combobox.Root
      value={value}
      onValueChange={(v) => onChange((v as string) ?? "")}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (open) {
          setQuery("");
          if (projectId) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.branches(projectId),
            });
          }
        }
      }}
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger
        id={id}
        data-slot="combobox-trigger"
        className={cn(
          "group flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent bg-muted/40 px-3 py-2 font-mono text-sm transition-colors outline-none",
          "hover:bg-muted/60",
          "data-[popup-open]:border-input data-[popup-open]:bg-background data-[popup-open]:ring-2 data-[popup-open]:ring-ring/30",
          "focus-visible:border-input focus-visible:ring-2 focus-visible:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <span
          className={cn(
            "flex-1 truncate text-left",
            !value && "text-muted-foreground/70",
          )}
        >
          <Combobox.Value placeholder={placeholder ?? "Select a branch…"} />
        </span>
        <ChevronsUpDown
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60"
        />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner
          sideOffset={4}
          side="bottom"
          align="start"
          className="z-50"
        >
          <Combobox.Popup
            data-slot="combobox-popup"
            className="flex max-h-72 w-(--anchor-width) flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          >
            <div
              data-slot="combobox-search"
              className="flex items-center gap-2 border-b border-border px-3"
            >
              <Search
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
              <Combobox.Input
                placeholder="Search branches…"
                className="flex-1 bg-transparent py-2 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
              {isFetching && (
                <Loader2
                  aria-label="Syncing branches"
                  className="size-3.5 shrink-0 animate-spin text-muted-foreground/60"
                />
              )}
            </div>
            <Combobox.List className="flex-1 overflow-y-auto p-1">
              {sorted.length === 0 && !showCustom && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matching branches.
                </div>
              )}
              {sorted.map((entry) => (
                <Combobox.Item
                  key={`${entry.kind}:${entry.name}`}
                  value={entry.name}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <span className="flex-1 truncate font-mono">
                    {entry.name}
                  </span>
                  {entry.kind === "remote" && (
                    <span className="text-[10px] text-muted-foreground">
                      remote
                    </span>
                  )}
                </Combobox.Item>
              ))}
              {showCustom && (
                <Combobox.Item
                  value={trimmedQuery}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                >
                  <span className="text-muted-foreground">Use as ref:</span>
                  <span className="flex-1 truncate font-mono">
                    {trimmedQuery}
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
