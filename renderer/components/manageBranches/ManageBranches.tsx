import { useState } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";
import { useBranches } from "@/hooks/git/useBranches";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { rankByScore } from "@/lib/fuzzyMatch";
import { cn } from "@/lib/utils";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { BranchRow } from "./BranchRow";
import { NewBranchForm } from "./NewBranchForm";
import { PAGE_BODY } from "@/components/shared/PageShell";

export function ManageBranches() {
  return (
    <ProjectDevicePage title="Manage branches">
      {(scoped) => <BranchesBody project={scoped} />}
    </ProjectDevicePage>
  );
}

// The branch lists of whichever device the surrounding scope names.
function BranchesBody({ project }: { project: Project }) {
  const projectId = project.id;
  const { data: branches } = useBranches(projectId);
  const { data: worktrees = [] } = useWorktrees(projectId);
  const { data: defaultBranch } = useDefaultBranch(projectId);
  const [creating, setCreating] = useState(false);

  const worktreeByBranch = new Map<string, Worktree>();
  for (const w of worktrees) {
    if (isRealBranch(w.branch)) worktreeByBranch.set(w.branch, w);
  }

  const locals = branches?.local ?? [];
  const remotes = branches?.remote ?? [];

  return (
    <div className={PAGE_BODY}>
      <div className="flex flex-col gap-10">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <SectionHeading>Local branches</SectionHeading>
            {!creating && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => setCreating(true)}
              >
                <Plus />
                New branch
              </Button>
            )}
          </div>

          {creating && (
            <NewBranchForm
              projectId={projectId}
              defaultBase={defaultBranch ?? null}
              onDone={() => setCreating(false)}
            />
          )}

          {locals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No local branches yet.
            </p>
          ) : (
            <LocalBranchList
              projectId={projectId}
              names={locals}
              worktreeByBranch={worktreeByBranch}
            />
          )}
        </section>

        {remotes.length > 0 && <RemoteBranches names={remotes} />}
      </div>
    </div>
  );
}

function LocalBranchList({
  projectId,
  names,
  worktreeByBranch,
}: {
  projectId: string;
  names: string[];
  worktreeByBranch: Map<string, Worktree>;
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
          {filtered.map((name) => (
            <BranchRow
              key={name}
              projectId={projectId}
              name={name}
              worktree={worktreeByBranch.get(name)}
            />
          ))}
        </div>
      )}
    </>
  );
}

// Collapsed by default: a big repo can carry hundreds of remote refs, and
// they're only reference material next to the local list.
function RemoteBranches({ names }: { names: string[] }) {
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
          className="group flex items-center gap-1.5 text-left uppercase"
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
