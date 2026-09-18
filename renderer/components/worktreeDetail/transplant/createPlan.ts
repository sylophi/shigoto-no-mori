// What the create on this device will do once a pull lands, read off
// the LOCAL project before it runs: the files carry-over brings, the
// setup command, and whether ports get provisioned. The review's
// cards and the running view's steps read the same answers, so the
// steps only name what the review already showed. Every hook here
// reads this machine, so callers sit under LocalHostScope.
import type { Project } from "@shared/schemas";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { usePortPoolActive } from "@/hooks/ports/usePortPoolActive";
import { worktreeIncludeExtras } from "@/hooks/projects/carryOverPaths";
import { useWorktreeIncludeStatus } from "@/hooks/projects/useWorktreeIncludeStatus";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";

// The local project's setup command, "" when none is configured (or
// the config has not loaded yet).
function useSetupScript(localProject: Project): string {
  const { data: config } = useShigomoriConfig(localProject.id);
  return config?.scripts?.setup?.trim() ?? "";
}

// The local project's carry-over: manual entries plus the repo's
// .worktreeinclude matches, merged by the same rule the Configure page
// uses. The include status is read unconditionally (like Configure
// does) so the two requests run side by side instead of the second
// waiting on the config.
export function useCarryOverRows(localProject: Project): {
  rows: { path: string; tag: string }[];
  isPending: boolean;
} {
  const { data: config, isPending } = useShigomoriConfig(localProject.id);
  const { data: include } = useWorktreeIncludeStatus(localProject.id);
  const manual = config?.carryOver ?? [];
  const included = worktreeIncludeExtras(
    manual,
    config?.useWorktreeInclude !== false,
    include,
  );
  return {
    rows: [
      ...manual.map((e) => ({ path: e.path, tag: e.mode as string })),
      ...included.map((path) => ({ path, tag: "include" })),
    ],
    isPending,
  };
}

// Whether the create provisions ports. The new worktree does not exist
// yet, so the primary checkout answers for it: port-pool is on for a
// managed worktree when the toggle is on and the repo carries its
// config, which the primary shares with every worktree cut from it.
function useProvisionsPorts(localProject: Project): boolean {
  const { data: worktrees } = useWorktrees(localProject.id);
  const primary = worktrees?.find((entry) => entry.isPrimary);
  const { data: active } = usePortPoolActive(localProject.id, primary?.id);
  return active === true;
}

type CreatePlan = {
  carryOverCount: number;
  // "" when the project has no setup script.
  setupCommand: string;
  provisionsPorts: boolean;
};

export function useCreatePlan(localProject: Project): CreatePlan {
  return {
    carryOverCount: useCarryOverRows(localProject).rows.length,
    setupCommand: useSetupScript(localProject),
    provisionsPorts: useProvisionsPorts(localProject),
  };
}
