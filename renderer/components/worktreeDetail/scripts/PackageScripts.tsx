import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  usePackageScriptSort,
  useSetPackageScriptSort,
} from "@/hooks/scripts/usePackageScriptSort";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import type { PackageScriptsResult, Worktree } from "@shared/schemas";
import { ScriptList } from "./ScriptList";
import { ScriptRow } from "./ScriptRow";
import { SortMenu } from "../SortMenu";
import { sortEntries } from "./sortPackageScripts";

interface PackageScriptsProps {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}

export function PackageScripts({ worktree, pkg }: PackageScriptsProps) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const { data: sortMode = "frequent" } = usePackageScriptSort(
    worktree.projectId,
  );
  const setSortMode = useSetPackageScriptSort(worktree.projectId);
  const entries = Object.entries(pkg.scripts);

  const sorted = sortEntries(entries, sortMode, pkg.usage);
  const filtered = rankByScore(query, sorted, (e) => e.name);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="group flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 text-muted-foreground/60 transition-transform group-hover:text-muted-foreground",
              expanded && "rotate-90",
            )}
          />
          <span className="font-mono text-muted-foreground group-hover:text-foreground">
            package.json
          </span>
        </button>
        {expanded && (
          <SortMenu
            value={sortMode}
            onChange={(mode) => setSortMode.mutate(mode)}
          />
        )}
      </div>

      {expanded && (
        <>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/60"
            />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search scripts…"
              className="w-full py-1 pr-2.5 pl-7 text-xs"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="p-1 text-xs text-muted-foreground/70">No matches.</p>
          ) : (
            <ScriptList>
              {filtered.map((entry) => (
                <ScriptRow
                  key={entry.name}
                  worktree={worktree}
                  slot={{ kind: "package", name: entry.name }}
                  label={entry.name}
                  command={entry.command}
                />
              ))}
            </ScriptList>
          )}
        </>
      )}
    </div>
  );
}
