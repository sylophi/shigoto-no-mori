// Single source of truth for the filesystem helper's distribution: the Go
// module in nativefs/ compiles to one binary that ships beside the CLI in
// the app's Resources and lands in a gitignored dist dir in dev.
// Imported by the build script and forge.config.ts. Like file-sync it
// has no flavor: it never touches a data dir.
//
// .mts with no imports: plain `node scripts/*.mts` must load it.

// Repo-relative directory the compiled binary lands in (gitignored).
export const NATIVEFS_DIST_DIR = "dist-nativefs";

export const NATIVEFS_BINARY_NAME = "nativefs";
