// The per-worktree dev app bundle on macOS, shared by the dev
// launchers (scripts/dev-electron.mts, scripts/dev-peer.mts).
//
// Why a bundle at all: Clerk's social (browser-redirect) sign-in comes
// back as a shigomori-dev://app deep link, and macOS routes a custom
// scheme only to an app bundle whose Info.plist claims it. The bare
// Electron binary forge would normally spawn belongs to node_modules'
// Electron.app (bundle id com.github.Electron), so the callback never
// reaches the dev app and social sign-in dies half-finished. The fix
// (same shape t3 code ships): clone Electron.app into a gitignored
// per-worktree bundle, rewrite its Info.plist to claim the dev scheme
// under a worktree-unique bundle id, register it with LaunchServices,
// and make forge launch THAT copy. The running dev process then lives
// inside the registered bundle, so the OS delivers open-url events
// straight to it, and the Clerk bridge's setAsDefaultProtocolClient
// call works because the process finally has a registrable bundle
// identity.
//
// The bundle id is per worktree, but the scheme is one spelling
// (shared/rendererScheme.mts), so across several dev worktrees the
// last one launched owns the deep links. That is the workflow that
// makes sense: you sign in wherever you are currently working. A cold
// activation (a deep link arriving with no dev app running) launches
// the stock executable with no app and shows Electron's welcome
// window: a harmless dead end, deliberately not wired to boot the
// real app, which would grab the single-instance lock and linger as a
// half-alive instance.
//
// Never touch node_modules/electron itself: pnpm hard-links package
// files from a shared store, so an edit there could bleed into every
// other worktree's install.
import { type ChildProcess, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { DEV_NAME_SUFFIX } from "../../shared/appName.mts";
import { APP_BUNDLE_ID } from "../../shared/cliDist.mts";
import { LOCAL_NETWORK_USAGE_DESCRIPTION } from "../../shared/infoPlist.mts";
import { rendererSchemeName } from "../../shared/rendererScheme.mts";

import { repoRoot } from "./checkKit.mjs";

const require = createRequire(import.meta.url);
export const productName = require("../../package.json").productName as string;

// Bumped when the bundle recipe below changes shape, so existing
// clones rebuild. The value-derived stamp fields cover everything
// else.
const BUNDLE_LAYOUT = 3;

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A" +
  "/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

const runtimeDir = join(repoRoot, ".electron-dev");
const distDir = join(runtimeDir, "dist");
const appPath = join(distDir, "Electron.app");
const bundleExecutable = join(appPath, "Contents", "MacOS", "Electron");

function plutilReplace(
  plist: string,
  key: string,
  type: "string" | "json",
  value: string,
): void {
  execFileSync("plutil", ["-replace", key, `-${type}`, value, plist]);
}

// Worktree-unique, human-scannable bundle id suffix: the directory
// name for the human, a path hash for uniqueness (two worktrees can
// share a basename across different parents). Deliberately not
// host/lib's worktreeIdFromPath: that is app-runtime code a plain
// node script cannot load, and this id names a bundle, not a
// worktree, so the two owe each other nothing.
function worktreeSuffix(): string {
  const name = basename(repoRoot)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}

// The stock Electron binary node_modules resolves to, for platforms
// without a dev bundle and for a peer launched before any bundle
// exists.
export function stockElectronExecutable(): string {
  return require("electron") as string;
}

// The dev bundle's executable when one has been built for this
// worktree, else null. A peer instance (scripts/dev-peer.mts) runs
// from it so the OS sees one app, not a second Electron with its own
// dock icon. It never (re)builds or (re)registers it, that is the
// primary launcher's job.
export function devBundleExecutable(): string | null {
  return existsSync(bundleExecutable) ? bundleExecutable : null;
}

// Builds (or reuses) the per-worktree dev bundle and registers it with
// LaunchServices. Returns the dist dir to point
// ELECTRON_OVERRIDE_DIST_PATH at.
export function ensureDevBundle(): string {
  // Requiring electron resolves the stock binary, downloading dist/ on
  // a fresh worktree exactly as forge's own start would. The bundle
  // sits three levels above it (Electron.app/Contents/MacOS/Electron),
  // and the clone must keep that exact inner layout: forge resolves
  // the executable inside the override dir through the same
  // electron/index.js path logic.
  const srcApp = resolve(stockElectronExecutable(), "..", "..", "..");
  const electronVersion = require("electron/package.json").version as string;

  const devName = `${productName}${DEV_NAME_SUFFIX}`;
  const bundleId = `${APP_BUNDLE_ID}.dev.${worktreeSuffix()}`;
  const scheme = rendererSchemeName("dev");
  const stampPath = join(runtimeDir, "stamp.json");

  // The stamp carries the values actually baked into the bundle, so a
  // productName rename or an electron bump rebuilds and a no-op edit
  // to this file does not.
  const stamp = JSON.stringify({
    layout: BUNDLE_LAYOUT,
    electronVersion,
    bundleId,
    scheme,
    devName,
  });
  const usable = existsSync(bundleExecutable);
  const fresh =
    usable &&
    existsSync(stampPath) &&
    readFileSync(stampPath, "utf8") === stamp;

  if (!fresh) {
    // Never delete a bundle a live dev app is executing from: its
    // helper respawns would hit unlinked files. Reuse the stale clone
    // and let the next cold start rebuild.
    if (usable && processRunningFrom(appPath)) {
      console.warn(
        "[dev-electron] bundle is stale but in use by a running dev app, reusing it",
      );
    } else {
      console.log(`[dev-electron] building dev app bundle (${bundleId})`);
      rmSync(runtimeDir, { recursive: true, force: true });
      mkdirSync(distDir, { recursive: true });
      try {
        // APFS clonefile: a ~300 MB "copy" in milliseconds.
        execFileSync("cp", ["-Rc", srcApp, appPath]);
      } catch (error) {
        // Non-APFS volumes pay a real multi-second copy. Say so
        // instead of silently losing the advertised fast path.
        console.warn(`[dev-electron] clonefile failed (${error}), full copy`);
        rmSync(appPath, { recursive: true, force: true });
        execFileSync("cp", ["-R", srcApp, appPath]);
      }

      const plist = join(appPath, "Contents", "Info.plist");
      plutilReplace(plist, "CFBundleIdentifier", "string", bundleId);
      plutilReplace(plist, "CFBundleName", "string", devName);
      plutilReplace(plist, "CFBundleDisplayName", "string", devName);
      // Same entry forge writes into the packaged app, so a dev build's
      // first LAN dial gets the Local Network prompt too.
      plutilReplace(
        plist,
        "NSLocalNetworkUsageDescription",
        "string",
        LOCAL_NETWORK_USAGE_DESCRIPTION,
      );
      plutilReplace(
        plist,
        "CFBundleURLTypes",
        "json",
        // URL name = display name, the same shape electron-packager
        // derives from forge.config.ts's protocols entry for prod.
        JSON.stringify([
          { CFBundleURLName: devName, CFBundleURLSchemes: [scheme] },
        ]),
      );

      // The plist edits broke the ad-hoc seal Electron ships with, and
      // macOS refuses to run a bundle whose signature no longer
      // matches. Re-seal ad-hoc: no identity needed, dev machine only.
      // Top level only: the nested frameworks are untouched and keep
      // Electron's own ad-hoc signatures (and --deep would spend
      // ~600 ms re-signing 275 MB of them).
      execFileSync("codesign", ["--force", "--sign", "-", appPath]);
      writeFileSync(stampPath, stamp);
    }
  }

  // Both run every launch: lsregister tells LaunchServices the bundle
  // exists (and re-pins it after a rebuild), and the default-handler
  // set is what actually hands the scheme to this worktree, so the
  // most recently launched worktree owns the deep links.
  execFileSync(LSREGISTER, ["-f", appPath]);
  execFileSync("osascript", [
    "-l",
    "JavaScript",
    "-e",
    "ObjC.import('CoreServices'); " +
      `$.LSSetDefaultHandlerForURLScheme($('${scheme}'), $('${bundleId}'));`,
  ]);
  return distDir;
}

function processRunningFrom(bundle: string): boolean {
  try {
    execFileSync("pgrep", ["-f", bundle], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Ties a launcher to the app process it spawned: direct signals (an
// editor's stop button, kill <pid>) are forwarded instead of orphaning
// the child with its ports and the single-instance lock, and the
// launcher exits with the child. Ctrl-C is a normal dev stop, not a
// failure pnpm should report.
export function superviseChild(child: ChildProcess, label: string): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`[dev] failed to launch ${label}: ${error}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    const interrupted = signal === "SIGINT" || signal === "SIGTERM";
    process.exit(interrupted ? 0 : (code ?? 1));
  });
}
