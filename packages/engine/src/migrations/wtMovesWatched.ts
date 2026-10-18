import { watchTable } from "./changes.ts";

// Every re-key whose checkout moved records itself in `wt_moves` (a
// move, a rename, an adopt, a project relocate, the data-folder move),
// and the host follows the mirrors it keeps under a worktree's id from
// it, whichever process made the re-key.
export const wtMovesWatched = watchTable("wt_moves");
