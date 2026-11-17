// What a test sets or skips by the OS it runs on.
import type { TestContext } from "vitest";

// `dir` as the user's home folder, which Windows reads from USERPROFILE.
export const homeEnv = (dir: string) => ({ HOME: dir, USERPROFILE: dir });

// v2 never ran on Windows, so no v2 worktree is there to move, and the
// move asks lsof, which Windows lacks, what runs in one.
export const whereV2Ran = ({ skip }: TestContext) =>
  skip(process.platform === "win32", "v2 never ran on Windows");
