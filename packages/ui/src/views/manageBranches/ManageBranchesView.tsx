import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import { Input } from "../../primitives/input.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import { rankByScore } from "../../lib/fuzzyMatch.ts";
import { cn } from "../../lib/utils.ts";
import { PAGE_BODY } from "../shared/PageShellView.tsx";

// A device's branch lists (ManageBranches.tsx binds them): the local
// ones with their rows, and the remote-tracking ones for reference.
export function ManageBranchesView({
  creating,
  onCreate,
  newBranchForm,
  localNames,
  rows,
  remotes,
}: {
  // The new-branch form is open (`newBranchForm`).
  creating: boolean;
  onCreate: () => void;
  newBranchForm: ReactNode;
  localNames: readonly string[];
  // Each local branch's row (BranchRow), by name.
  rows: ReadonlyMap<string, ReactNode>;
  remotes: readonly string[];
}) {
  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-10">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionHeading>Local branches</SectionHeading>
            {!creating && (
              <Button size="xs" variant="outline" onClick={onCreate}>
                <Plus />
                New branch
              </Button>
            )}
          </div>

          {creating && newBranchForm}

          {localNames.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No local branches yet.
            </p>
          ) : (
            <LocalBranchListView names={localNames} rows={rows} />
          )}
        </section>

        {remotes.length > 0 && <RemoteBranchesView names={remotes} />}
      </div>
    </div>
  );
}

export function LocalBranchListView({
  names,
  rows,
}: {
  names: readonly string[];
  // Each branch's row (BranchRow), by name.
  rows: ReadonlyMap<string, ReactNode>;
}) {
  const [query, setQuery] = useState("");
  const filtered = rankByScore(query.trim(), names, (name) => name);

  return (
    <>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search branches…"
          className="w-full py-1.5 pr-3 pl-8 text-sm"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matches.</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {filtered.map((name) => rows.get(name))}
        </div>
      )}
    </>
  );
}

// Collapsed by default: a big repo can carry hundreds of remote refs, and
// they're only reference material next to the local list.
export function RemoteBranchesView({ names }: { names: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className="space-y-3">
      <SectionHeading>
        {/* The browser's button styles reset text-transform, so the
            heading's uppercase has to be restated here. */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="group -mx-1 flex items-center gap-1.5 rounded-md px-1 text-left uppercase hover:bg-muted dark:hover:bg-muted/50"
        >
          <span className="group-hover:text-foreground">
            Remote-tracking branches
          </span>
          <span className="font-normal text-muted-foreground/60 tabular-nums">
            {names.length}
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
              expanded && "rotate-90",
            )}
          />
        </button>
      </SectionHeading>
      {expanded && (
        <>
          <p className="text-xs text-muted-foreground">
            Read-only references. Use one as a source when creating a new local
            branch.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {names.map((name) => (
              <span
                key={name}
                className="rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground select-text"
              >
                {name}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
