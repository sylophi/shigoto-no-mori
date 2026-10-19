// Where a worktree's lifecycle scripts write (Lifecycle.run): one file
// for each script, its last run's, replaced by the next and gone with
// the worktree.
import { join } from "node:path";

export const scriptOutputDir = (dataDir: string, worktreeId: string) =>
  join(dataDir, "script-output", worktreeId);

export const scriptOutputPath = (
  dataDir: string,
  worktreeId: string,
  script: string,
) => join(scriptOutputDir(dataDir, worktreeId), `${script}.log`);
