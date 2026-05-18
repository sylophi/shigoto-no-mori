import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: "assets/icon",
    appBundleId: "com.sylophi.shigomori",
    appCopyright: "© 2026 sylophi",
    // No `osxSign` here — the @electron/osx-sign@1.3.3 that Forge ships
    // silently skips ad-hoc signing when no real cert is in the keychain.
    // We codesign by hand in the postPackage hook below.
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_config, result) => {
      // Ad-hoc codesign the .app bundle. macOS-only — skip on non-darwin
      // platforms where there's no `codesign` and no .app bundle to sign.
      if (process.platform !== "darwin") return;

      await Promise.all(
        result.outputPaths.map(async (dir) => {
          const entries = await readdir(dir);
          const appName = entries.find((e) => e.endsWith(".app"));
          if (!appName) return;
          const appPath = path.join(dir, appName);
          // `--deep` is deprecated for fixing already-signed bundles, but
          // it's still the supported way to apply a fresh ad-hoc signature
          // across an Electron app's many nested frameworks and helpers.
          await exec("codesign", ["--force", "--deep", "--sign", "-", appPath]);
        }),
      );
    },
  },
  makers: [new MakerZIP({}, ["darwin"])],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
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
