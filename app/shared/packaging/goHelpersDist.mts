// Single source of truth for the distribution of the Go helpers: the
// file-sync engine (file-sync/), the filesystem helper (nativefs/) and,
// on Windows, the terminal command's launcher (cli-launcher/). Each
// module compiles to one binary that ships beside the CLI in the app's
// Resources and lands in a gitignored dist dir in dev.
// Imported by the build script, forge.config.ts and the host's
// resolvers so a rename is a one-file change. Unlike the CLI, file-sync
// and nativefs have no flavor: neither resolves a data dir itself (the
// host names file-sync's data directory on every spawn), so one binary
// serves both prod and dev. The launcher is built per flavor, since it
// runs the flavor's CLI.
//
// .mts with no imports: plain `node scripts/*.mts` must load it.

// Repo-relative directories the compiled binaries land in (gitignored).
export const FILE_SYNC_DIST_DIR = "dist-file-sync";
export const NATIVEFS_DIST_DIR = "dist-nativefs";
export const CLI_LAUNCHER_DIST_DIR = "dist-cli-launcher";

export const FILE_SYNC_BINARY_NAME = "file-sync";
export const NATIVEFS_BINARY_NAME = "nativefs";
export const CLI_LAUNCHER_BINARY_NAME = "cli-launcher";
