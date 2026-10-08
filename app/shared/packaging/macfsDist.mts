// Single source of truth for the darwin helper's distribution: the Go
// module in macfs/ compiles to one binary that ships beside the CLI in
// the app's Resources and lands in a gitignored dist dir in dev.
// Imported by the build script and forge.config.ts. Like file-sync it
// has no flavor: it never touches a data dir.
//
// .mts with no imports: plain `node scripts/*.mts` must load it.

// Repo-relative directory the compiled binary lands in (gitignored).
export const MACFS_DIST_DIR = "dist-macfs";

export const MACFS_BINARY_NAME = "macfs";
