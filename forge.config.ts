import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

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

// Target platform of this build: the host by default, overridden by
// `--platform win32` / `--platform=win32` / `-p win32` when
// cross-packaging (e.g. building a Windows test app from macOS to run
// under CrossOver).
function targetPlatform(): string {
  const eq = process.argv.find((a) => a.startsWith("--platform="));
  if (eq) return eq.slice("--platform=".length);
  const idx = process.argv.findIndex((a) => a === "--platform" || a === "-p");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.platform;
}
const isWindowsTarget = targetPlatform() === "win32";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "assets/icon",
    appBundleId: "com.sylophi.shigomori",
    appCopyright: "© 2026 sylophi",
    extraResource: ["resources/licenses"],
    // Squirrel.Windows tooling (Update.exe --processStart shortcut
    // targets, nupkg packing) has a long history of breaking on spaces
    // in the exe name, so Windows builds get a space-free executable.
    // Scoped to win32 targets so the macOS bundle keeps its productName
    // binary.
    ...(isWindowsTarget ? { executableName: "shigoto-no-mori" } : {}),
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
  rebuildConfig: {},
  hooks: {
    prePackage: async () => {
      execFileSync("node", ["scripts/generate-third-party-licenses.mjs"], {
        cwd: import.meta.dirname,
        stdio: "inherit",
      });
    },
  },
  makers: [
    new MakerZIP({}, ["darwin"]),
    // Squirrel.Windows: produces Setup.exe plus the RELEASES/.nupkg pair
    // that update.electronjs.org serves to the in-app autoUpdater.
    // Unsigned for now -- Authenticode signing slots in here via
    // `windowsSign` once a certificate exists.
    new MakerSquirrel(
      {
        // Required nuspec metadata; electron-winstaller errors out when
        // neither this nor package.json's author is set.
        authors: "sylophi",
        setupIcon: "assets/icon.ico",
        // Shown in Add/Remove Programs; must be a URL, not a local path.
        iconUrl:
          "https://raw.githubusercontent.com/sylophi/shigoto-no-mori/main/assets/icon.ico",
      },
      ["win32"],
    ),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "sylophi",
        name: "shigoto-no-mori",
      },
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
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "main/preload.ts",
          config: "vite.preload.config.ts",
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
