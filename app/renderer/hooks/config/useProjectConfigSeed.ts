import { errorMessageOf } from "@shared/errors";
import type { ShigomoriConfig } from "@shared/schemas";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";

// What the two project-entry editors (Configure, Worktree location)
// seed from: the project file and the resolved default branch, as one
// three-way verdict. Both editors write the WHOLE entry back (the
// CLI's merge drops every key the payload omits, and the keys a form
// doesn't model survive only by being spread from what was read), so a
// form seeded from a failed read would save over everything the file
// holds. A failed read is therefore its own state, with the reason and
// a retry, never an empty seed. The gate is on the data being absent,
// not on isError alone, so a failed background refetch cannot swap an
// open form (and its unsaved edits) for the failure. A config of null
// is a real answer (no project file yet) and seeds the form as usual.
// Only undefined means the read has not landed.
export type ProjectConfigSeed =
  | { state: "loading" }
  | { state: "failed"; message: string; retry: () => void }
  | {
      state: "ready";
      config: ShigomoriConfig | null;
      resolvedDefaultBranch: string;
    };

export function useProjectConfigSeed(projectId: string): ProjectConfigSeed {
  const config = useShigomoriConfig(projectId);
  const branch = useDefaultBranch(projectId);
  if (config.data === undefined && config.isError) {
    return {
      state: "failed",
      message: `Couldn't load this project's config: ${errorMessageOf(config.error)}.`,
      retry: () => void config.refetch(),
    };
  }
  // Without the branch the skeleton would otherwise stay up for good,
  // with nothing saying why.
  if (branch.data === undefined && branch.isError) {
    return {
      state: "failed",
      message: `Couldn't resolve the default branch: ${errorMessageOf(branch.error)}.`,
      retry: () => void branch.refetch(),
    };
  }
  if (config.data === undefined || branch.data === undefined) {
    return { state: "loading" };
  }
  return {
    state: "ready",
    config: config.data,
    resolvedDefaultBranch: branch.data,
  };
}
