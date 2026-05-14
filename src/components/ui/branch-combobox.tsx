import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBranches } from "@/hooks/useBranches";

interface BranchComboboxProps {
  projectId: string | null;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

interface BranchEntry {
  name: string;
  kind: "local" | "remote";
}

// Higher score = better match. 0 = no match.
function scoreMatch(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return 200 - idx * 2 + Math.round((q.length / t.length) * 50);
  }
  let pos = 0;
  let gaps = 0;
  for (const c of q) {
    const next = t.indexOf(c, pos);
    if (next < 0) return 0;
    gaps += next - pos;
    pos = next + 1;
  }
  return Math.max(1, 80 - gaps);
}

export function BranchCombobox({
  projectId,
  value,
  onChange,
  placeholder,
  id,
  disabled,
  className,
}: BranchComboboxProps) {
  const { data: branches } = useBranches(projectId);
  const [query, setQuery] = useState("");

  const all: BranchEntry[] = [
    ...(branches?.local ?? []).map((name) => ({
      name,
      kind: "local" as const,
    })),
    ...(branches?.remote ?? []).map((name) => ({
      name,
      kind: "remote" as const,
    })),
  ];
  const sorted: BranchEntry[] = query
    ? all
        .map((b) => ({ b, score: scoreMatch(query, b.name) }))
        .filter((x) => x.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map((x) => x.b)
    : all;

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
        if (open) setQuery("");
      }}
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger
        id={id}
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
          <Combobox.Popup className="flex max-h-72 w-(--anchor-width) flex-col overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60"
              />
              <Combobox.Input
                placeholder="Search branches…"
                className="flex-1 bg-transparent py-2 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground"
              />
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
