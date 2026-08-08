// Single source of truth for the sgm CLI's flavor system: what each
// flavor's binary is called, which state root it targets, where user
// binaries get linked, and how links are (re)pointed. Imported from
// every boundary that needs the policy -- app main (sgmCli.ts), the
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
export type SgmFlavor = "prod" | "dev";

// Repo-relative directory compiled binaries land in (gitignored).
export const SGM_DIST_DIR = "dist-cli";

export function sgmBinaryName(flavor: SgmFlavor, windows = false): string {
  const base = flavor === "prod" ? "sgm" : "sgm-d";
  return windows ? `${base}.exe` : base;
}

// Directory name under $HOME holding the flavor's on-disk state
// (state.json, projects/, managed worktrees).
export function sgmRootDirName(flavor: SgmFlavor): string {
  return flavor === "prod" ? "shigomori" : "shigomori-dev";
}

// Where user-facing executables get linked. The XDG spec's location
// for user executables is ~/.local/bin (it defines no env var for it);
// honor the de-facto XDG_BIN_HOME override when set. Caveat: a
// packaged app launched from Finder inherits launchd's environment, so
// a profile-exported XDG_BIN_HOME is only visible if set via
// launchctl -- the fallback covers the rest.
export function sgmUserBinDir(): string {
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
