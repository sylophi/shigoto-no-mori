import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  APP_BUNDLE_ID,
  CLI_DIST_DIR,
  cliBinaryName,
  UPDATE_FEED_REPO,
} from "./shared/cliDist.mts";
import { productName, version } from "./package.json";
import {
  NODE_PTY_ADDON,
  NODE_PTY_SPAWN_HELPER,
  nodePtyPrebuildDir,
} from "./shared/nodePty.mts";
import {
  DMG_APP_ICON,
  DMG_APPS_ICON,
  DMG_ICON_SIZE,
  DMG_WINDOW,
  dmgBackgroundFor,
} from "./shared/dmgLayout.mts";

loadEnv();

const osxNotarizeConfig = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE
  ? {
      keychainProfile: process.env.APPLE_NOTARY_KEYCHAIN_PROFILE,
    }
  : process.env.APPLE_ID &&
      process.env.APPLE_APP_SPECIFIC_PASSWORD &&
      process.env.APPLE_TEAM_ID
    ? {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      }
    : undefined;

const shouldSignMac = Boolean(process.env.APPLE_SIGNING_IDENTITY);
const shouldNotarizeMac = shouldSignMac && Boolean(osxNotarizeConfig);

const [feedOwner, feedName] = UPDATE_FEED_REPO.split("/");

// The dmg's volume name -- what Finder prints in the window's title bar
// while someone installs. It carries the full version, prerelease tag
// and all, but the name also goes into the alias record ds-store writes
// into the image's .DS_Store, and that format stores it in a 27-byte
// field: macos-alias asserts rather than truncating, so a long version
// fails the release build outright (`Volume name is not longer than 27
// chars`). Take the first spelling that fits: the product name, then
// the short one the bundle id uses, then the bare version.
const DMG_VOLUME_NAME_MAX = 27;
const dmgVolumeName =
  [`${productName} v${version}`, `Shigomori v${version}`].find(
    (name) => name.length <= DMG_VOLUME_NAME_MAX,
  ) ?? `v${version}`.slice(0, DMG_VOLUME_NAME_MAX);

// Forge's Vite plugin normally ships only the .vite/ bundles. node-pty
// (the script console's PTY) is the one dependency Vite can't bundle:
// its loader requires the native addon by path and posix_spawns the
// spawn-helper next to it, so the package has to exist as real files
// -- its manifest, the JS in lib/, and the prebuilt darwin binaries.
// Everything else in the package (sources, typings, tests' fixtures)
// stays out, as does every other node_modules entry. Paths always
// start with "/" and directories are filtered too, so the node_modules
// parents have to pass for their children to be visited.
const NODE_PTY_SHIPPED =
  /^\/node_modules(\/node-pty(\/(package\.json|lib(\/.*)?|prebuilds(\/darwin-.*)?))?)?$/;
const packagerIgnore = (file: string): boolean => {
  if (!file) return false;
  if (file.startsWith("/.vite")) return false;
  return !NODE_PTY_SHIPPED.test(file);
};

const config: ForgeConfig = {
  packagerConfig: {
    // The native addon and spawn-helper are loaded by path at runtime,
    // which only works from app.asar.unpacked (node-pty rewrites its
    // own helper path accordingly).
    asar: { unpack: "**/node_modules/node-pty/**" },
    ignore: packagerIgnore,
    icon: "assets/icon",
    appBundleId: APP_BUNDLE_ID,
    appCopyright: "© 2026 sylophi",
    // The CLI binary is compiled by the prePackage hook below into
    // dist-cli/ and shipped in Resources; Settings offers to link it
    // into the user's bin dir.
    extraResource: [
      "resources/licenses",
      `${CLI_DIST_DIR}/${cliBinaryName("prod")}`,
    ],
    ...(shouldSignMac
      ? {
          osxSign: {
            identity: process.env.APPLE_SIGNING_IDENTITY,
          },
        }
      : {}),
    ...(shouldNotarizeMac
      ? {
          osxNotarize: osxNotarizeConfig,
        }
      : {}),
  },
  // node-pty ships Node-API prebuilds that work in Electron as-is
  // (scripts/fix-node-pty-helper.mjs makes the helper executable, since
  // install scripts are disabled). Skipping the rebuild keeps a compiler
  // toolchain out of the dev loop and makes dev and packaged builds run
  // the same binary.
  rebuildConfig: { ignoreModules: ["node-pty"] },
  hooks: {
    prePackage: async () => {
      execFileSync("node", ["scripts/generate-third-party-licenses.mjs"], {
        cwd: import.meta.dirname,
        stdio: "inherit",
      });
      // Compile the CLI (requires Go on the build machine).
      execFileSync("node", ["scripts/build-cli.mjs"], {
        cwd: import.meta.dirname,
        stdio: "inherit",
      });
    },
    // The ignore above spells out node-pty's layout. If a release moves
    // it, fail the build here, not the first script run of a shipped app.
    packageAfterCopy: async (_config, buildPath, _electron, platform, arch) => {
      const prebuild = path.join(buildPath, nodePtyPrebuildDir(platform, arch));
      for (const file of [NODE_PTY_ADDON, NODE_PTY_SPAWN_HELPER]) {
        const full = path.join(prebuild, file);
        const mode =
          file === NODE_PTY_SPAWN_HELPER ? fsConstants.X_OK : fsConstants.R_OK;
        try {
          accessSync(full, mode);
        } catch {
          throw new Error(`node-pty is not packaged correctly: ${full}`);
        }
      }
    },
  },
  // The dmg is what humans download: it opens the familiar
  // drag-to-Applications window instead of leaving the app wherever
  // Safari expanded it. The zip stays because the update feed serves
  // it to the in-app updater.
  makers: [
    // The window a download opens into is the app's first impression,
    // so it gets the doubutsu treatment too: brand plaque, leaf
    // wallpaper, hint band. The artwork (and the @2x twin appdmg picks
    // up by name) is generated by `pnpm dmg:background` from the app's
    // own stylesheet. The icon coordinates below come from the same
    // module the artwork is drawn from, so the icons land on their
    // painted tiles.
    //
    // Which flavor a prerelease gets, and both file names, are
    // dmgLayout's call -- see dmgBackgroundFor.
    new MakerDMG(
      {
        // The version rides the volume name rather than the artwork --
        // the art is a committed png and would go stale every release.
        title: dmgVolumeName,
        icon: "assets/icon.icns",
        background: dmgBackgroundFor(version),
        iconSize: DMG_ICON_SIZE,
        additionalDMGOptions: { window: { size: { ...DMG_WINDOW } } },
        contents: (opts) => [
          { ...DMG_APP_ICON, type: "file", path: opts.appPath },
          { ...DMG_APPS_ICON, type: "link", path: "/Applications" },
        ],
      },
      ["darwin"],
    ),
    new MakerZIP({}, ["darwin"]),
  ],
  publishers: [
    new PublisherGithub({
      // Derived, not restated: publishing to a repo the CLI's updater
      // doesn't poll would look exactly like "no updates ever appear".
      repository: { owner: feedOwner, name: feedName },
      draft: false,
    }),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "main/index.ts",
          config: "vite.node.config.ts",
          target: "main",
        },
        {
          entry: "main/preload.ts",
          config: "vite.node.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Disabled: the app has no cookies/sessions/autofill to protect,
      // and turning this on triggers a "Shigoto no Mori wants to use
      // your confidential information" keychain prompt on every launch
      // since ad-hoc signatures differ between builds.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
