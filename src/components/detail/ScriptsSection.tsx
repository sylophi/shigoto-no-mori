import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Play, Search, Square } from "lucide-react";
import { scoreMatch } from "@/components/ui/branch-combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { usePackageScripts } from "@/hooks/usePackageScripts";
import { usePortPoolActive } from "@/hooks/usePortPoolActive";
import { useScriptRunner } from "@/hooks/useScriptRunner";
import { useShigomoriConfig } from "@/hooks/useShigomoriConfig";
import { cn } from "@/lib/utils";
import {
  slotToParam,
  useWorktreeHasPackageActivity,
  type ScriptSlot,
} from "@/store/scriptRuns";
import type { PackageScriptsResult, Worktree } from "@shared/schemas";
import { ScriptStatusBadge } from "./ScriptStatusBadge";

interface ScriptsSectionProps {
  worktree: Worktree;
}

export function ScriptsSection({ worktree }: ScriptsSectionProps) {
  const navigate = useNavigate();
  const { data: config, isLoading: configLoading } = useShigomoriConfig(
    worktree.projectId,
  );
  const { data: pkg, isLoading: pkgLoading } = usePackageScripts(
    worktree.projectId,
    worktree.id,
  );
  const { data: portPoolActive = false } = usePortPoolActive(
    worktree.projectId,
    worktree.id,
  );

  const goConfigure = () =>
    void navigate({
      to: "/projects/$projectId/configure",
      params: { projectId: worktree.projectId },
    });

  if (configLoading || pkgLoading) {
    return (
      <div className="space-y-1" aria-label="Loading scripts">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-full" />
      </div>
    );
  }

  const setupCommand = config?.scripts?.setup?.trim() ?? "";
  const teardownCommand = config?.scripts?.teardown?.trim() ?? "";
  const pkgHasScripts = pkg && Object.keys(pkg.scripts).length > 0;

  const lifecycleRows: { slot: ScriptSlot; label: string; command: string }[] =
    [];
  if (setupCommand) {
    lifecycleRows.push({
      slot: { kind: "setup" },
      label: "Setup",
      command: setupCommand,
    });
  }
  if (portPoolActive) {
    const quotedPath = worktreeQuotedPath(worktree.path);
    lifecycleRows.push({
      slot: { kind: "portPool", phase: "provision" },
      label: "Port-pool provision",
      command: `port-pool provision ${quotedPath}`,
    });
    lifecycleRows.push({
      slot: { kind: "portPool", phase: "release" },
      label: "Port-pool release",
      command: `port-pool release ${quotedPath}`,
    });
  }
  if (teardownCommand) {
    lifecycleRows.push({
      slot: { kind: "teardown" },
      label: "Teardown",
      command: teardownCommand,
    });
  }
  const hasLifecycle = lifecycleRows.length > 0;

  return (
    <div className="space-y-4">
      {lifecycleRows.length > 0 && (
        <ScriptList>
          {lifecycleRows.map((row, idx) => (
            <ScriptRow
              key={slotToParam(row.slot)}
              worktree={worktree}
              slot={row.slot}
              label={row.label}
              command={row.command}
              isLast={idx === lifecycleRows.length - 1}
            />
          ))}
        </ScriptList>
      )}

      {!hasLifecycle && (
        <button
          type="button"
          onClick={goConfigure}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Configure setup or teardown →
        </button>
      )}

      {pkg && pkgHasScripts && <PackageScripts worktree={worktree} pkg={pkg} />}
    </div>
  );
}

function ScriptList({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {children}
    </div>
  );
}

interface PackageScriptsProps {
  worktree: Worktree;
  pkg: PackageScriptsResult;
}

function PackageScripts({ worktree, pkg }: PackageScriptsProps) {
  const hasActivity = useWorktreeHasPackageActivity(worktree.id);
  // `null` means the user hasn't overridden the default; the section
  // follows hasActivity in that case. A manual toggle sticks until
  // the component unmounts (navigation), at which point a fresh
  // mount falls back to hasActivity again.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? hasActivity;
  const [query, setQuery] = useState("");
  const entries = Object.entries(pkg.scripts);

  const filtered = query
    ? entries
        .map(([name, command]) => ({
          name,
          command,
          score: scoreMatch(query, name),
        }))
        .filter((e) => e.score > 0)
        .toSorted((a, b) => b.score - a.score)
    : entries.map(([name, command]) => ({ name, command, score: 0 }));

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setManualExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-1.5 text-left text-xs transition-colors"
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
        <span className="text-muted-foreground/40">·</span>
        <span className="font-mono text-muted-foreground/70">
          {pkg.packageManager}
        </span>
        <span className="tabular ml-auto text-muted-foreground/50">
          {entries.length}
        </span>
      </button>

      {expanded && (
        <>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/60"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search scripts…"
              className="w-full rounded-md border border-input bg-background py-1 pr-2.5 pl-7 text-xs transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>

          {filtered.length === 0 ? (
            <p className="px-1 py-1 text-xs text-muted-foreground/70">
              No matches.
            </p>
          ) : (
            <ScriptList>
              {filtered.map((entry, idx) => (
                <ScriptRow
                  key={entry.name}
                  worktree={worktree}
                  slot={{ kind: "package", name: entry.name }}
                  label={entry.name}
                  command={entry.command}
                  isLast={idx === filtered.length - 1}
                />
              ))}
            </ScriptList>
          )}
        </>
      )}
    </div>
  );
}

interface ScriptRowProps {
  worktree: Worktree;
  slot: ScriptSlot;
  label: string;
  command: string;
  isLast: boolean;
}

function ScriptRow({ worktree, slot, label, command, isLast }: ScriptRowProps) {
  const navigate = useNavigate();
  const { state, busy, start, stop } = useScriptRunner(worktree, slot);
  // No history means there's nothing for the console to show, so the
  // right-side "view output" affordance only appears once a run lands.
  const hasHistory = state.status !== "idle";

  const openConsole = () =>
    void navigate({
      to: "/projects/$projectId/worktrees/$worktreeId/scripts/$scriptKey",
      params: {
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        scriptKey: slotToParam(slot),
      },
    });

  const actionLabel = busy ? `Stop ${label}` : `Run ${label}`;

  return (
    <div
      className={cn(
        "flex items-stretch text-xs",
        !isLast && "border-b border-border",
      )}
    >
      <button
        type="button"
        onClick={busy ? stop : start}
        disabled={state.cancelling}
        aria-label={actionLabel}
        title={command ? `${actionLabel}\n${command}` : actionLabel}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          busy ? "text-destructive hover:bg-destructive/10" : "hover:bg-accent",
        )}
      >
        {busy ? (
          <Square aria-hidden className="size-3 shrink-0" />
        ) : (
          <Play aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      </button>

      {hasHistory && (
        <button
          type="button"
          onClick={openConsole}
          aria-label={`View ${label} output`}
          title="View output"
          className="flex shrink-0 items-center gap-2 border-l border-border px-2.5 py-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <ScriptStatusBadge state={state} />
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        </button>
      )}
    </div>
  );
}

function worktreeQuotedPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}
