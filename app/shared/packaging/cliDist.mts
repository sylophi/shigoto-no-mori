// The CLI's paths: what each flavor's binary is called and which data
// dir it targets (the flavor table's, packages/engine/src/flavor.ts),
// where user binaries get linked, and how links are (re)pointed. The
// host (host/lib/cli), the build scripts and forge.config.ts import it.
//
// .mts importing node builtins and the import-free flavor table only:
// plain `node scripts/*.mts` must be able to load it without the CLI's
// loader shim or a bundler. Never import this from the renderer.
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { type Flavor, flavorNames } from "@shigomori/engine/flavor";

// Repo-relative directory compiled binaries land in (gitignored).
export const CLI_DIST_DIR = "dist-cli";

export function cliBinaryName(flavor: Flavor): string {
  return flavorNames(flavor).binaryName;
}

// Second command name installed beside the short one: the app's full
// name spelled out, for discoverability and for shells where `sm` is
// taken.
export function cliAliasName(flavor: Flavor): string {
  return flavorNames(flavor).alias;
}

// The data dir: the directory under $HOME holding the flavor's on-disk
// state (its store, projects/, managed worktrees). Short and
// dot-hidden on purpose: every managed worktree
// path starts with it, so it is in every prompt an agent sees.
export function cliDataDirName(flavor: Flavor): string {
  return flavorNames(flavor).dataDir;
}

// Where user-facing executables get linked. The XDG spec's location
// for user executables is ~/.local/bin (it defines no env var for it);
// honor the de-facto XDG_BIN_HOME override when set. Caveat: a
// packaged app launched from Finder inherits launchd's environment, so
// a profile-exported XDG_BIN_HOME is only visible if set via
// launchctl. The fallback covers the rest.
export function cliUserBinDir(): string {
  const xdg = process.env.XDG_BIN_HOME;
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return xdg;
  return join(homedir(), ".local", "bin");
}

// Atomically (re)point `link` at `target`: symlink to a temp name,
// then rename over the link, so a shell resolving the command
// mid-repair never sees a missing file.
export function replaceWithSymlinkSync(target: string, link: string): void {
  const dir = dirname(link);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(link)}.tmp-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}
