// Single source of truth for the CLI's flavor system: what each
// flavor's binary is called, which state root it targets, where user
// binaries get linked, and how links are (re)pointed. Imported from
// every boundary that needs the policy -- app main (cli.ts), the
// CLI itself, the build scripts, and forge.config.ts -- so a rename or
// relocation is a one-file change.
//
// .mts with node-builtin imports only: plain `node scripts/*.mjs` must
// be able to load it without the CLI's loader shim or a bundler. Never
// import this from the renderer.
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

// Mirrors the app's packaged/dev split (app.isPackaged): prod is what
// ships with the app and touches real state; dev is what `pnpm dev`
// links and can only ever touch dev state.
export type CliFlavor = "prod" | "dev";

// Repo-relative directory compiled binaries land in (gitignored).
export const CLI_DIST_DIR = "dist-cli";

// The packaged app's bundle id: forge.config.ts stamps it into the
// bundle and build-cli.mjs injects it into the CLI (`sm app` opens the
// app by bundle id), so the two can never disagree.
export const APP_BUNDLE_ID = "com.sylophi.shigomori";

// GitHub repo the update feed serves releases from. The CLI owns the
// whole update pipeline (cli/updater.go): build-cli.mjs injects this so
// the feed can never point at a different repo than the app came from.
export const UPDATE_FEED_REPO = "sylophi/shigoto-no-mori";

export function cliBinaryName(flavor: CliFlavor): string {
  return flavor === "prod" ? "sm" : "smd";
}

// Second command name installed beside the short one: the app's full
// name spelled out, for discoverability and for shells where `sm` is
// taken.
export function cliAliasName(flavor: CliFlavor): string {
  return flavor === "prod" ? "shigomori" : "shigomori-dev";
}

// Directory name under $HOME holding the flavor's on-disk state
// (state.json, projects/, managed worktrees).
export function cliRootDirName(flavor: CliFlavor): string {
  return flavor === "prod" ? "shigomori" : "shigomori-dev";
}

// The root pointer file: one line holding an absolute path that
// relocates the flavor's state root away from ~/<rootDirName>. Lives
// outside the root (the root's own config.json can't say where the
// root is), under $XDG_CONFIG_HOME (default ~/.config), keyed by the
// flavor's dir name so prod and dev move independently. Read at boot
// by app main (lib/util/paths.ts) and the CLI (state.go, which
// mirrors this policy), and written by the app when the user moves
// the data folder. SHIGOMORI_ROOT beats it on both sides.
export function rootPointerPath(flavor: CliFlavor): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, cliRootDirName(flavor), "root");
}

// Where user-facing executables get linked. The XDG spec's location
// for user executables is ~/.local/bin (it defines no env var for it);
// honor the de-facto XDG_BIN_HOME override when set. Caveat: a
// packaged app launched from Finder inherits launchd's environment, so
// a profile-exported XDG_BIN_HOME is only visible if set via
// launchctl -- the fallback covers the rest.
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
