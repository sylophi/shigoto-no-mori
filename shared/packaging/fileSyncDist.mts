// Single source of truth for the file-sync engine's distribution: the
// Go module in file-sync/ compiles to one binary that ships beside the
// CLI in the app's Resources and lands in a gitignored dist dir in
// dev. Imported by the build script, forge.config.ts and the main
// process resolver so a rename is a one-file change. Unlike the CLI it
// has no flavor: it never resolves a data dir itself (the host names
// the data directory on every spawn), so one binary serves both prod
// and dev.
//
// .mts with no imports: plain `node scripts/*.mjs` must load it.

// Repo-relative directory the compiled binary lands in (gitignored).
export const FILE_SYNC_DIST_DIR = "dist-file-sync";

export const FILE_SYNC_BINARY_NAME = "file-sync";
