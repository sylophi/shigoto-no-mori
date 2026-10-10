import { useState } from "react";
import { ProjectDevicePage } from "@/components/shared/ProjectDevicePage";
import { useBranches } from "@/hooks/git/useBranches";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import {
  isRealBranch,
  type Project,
  type Worktree,
} from "@shigomori/contracts/schemas";
import { BranchRow } from "./BranchRow";
import { NewBranchForm } from "./NewBranchForm";
import { ManageBranchesView } from "./ManageBranchesView";

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
    <ManageBranchesView
      creating={creating}
      onCreate={() => setCreating(true)}
      newBranchForm={
        <NewBranchForm
          projectId={projectId}
          defaultBase={defaultBranch ?? null}
          onDone={() => setCreating(false)}
        />
      }
      localNames={locals}
      rows={
        new Map(
          locals.map((name) => [
            name,
            <BranchRow
              key={name}
              projectId={projectId}
              name={name}
              worktree={worktreeByBranch.get(name)}
            />,
          ]),
        )
      }
      remotes={remotes}
    />
  );
}
