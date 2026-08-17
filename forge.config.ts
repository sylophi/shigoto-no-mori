import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerZIP } from "@electron-forge/maker-zip";
import { PublisherGithub } from "@electron-forge/publisher-github";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import {
  APP_BUNDLE_ID,
  CLI_DIST_DIR,
  cliBinaryName,
} from "./shared/cliDist.mts";

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

// Whether this build weakens the inspect-arguments fuse for the e2e
// driver. Only `electron-forge package` may do so; a make or publish
// with E2E_FUSES set fails loudly instead of shipping a distributable
// that any local process could relaunch with --inspect.
function e2eFuses(): boolean {
  if (process.env.E2E_FUSES !== "1") return false;
  const distributable = process.argv.some(
    (arg) => arg === "make" || arg === "publish",
  );
  if (distributable) {
    throw new Error(
      "E2E_FUSES=1 is set while building a distributable; unset it before make/publish.",
    );
  }
  return true;
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
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
  rebuildConfig: {},
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
  },
  makers: [new MakerZIP({}, ["darwin"])],
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
      // E2E_FUSES=1 produces a local `package` test build that
      // Playwright's _electron driver can attach to (it bootstraps
      // over the node inspector). Distributables must never honor it:
      // a stray export in the shell would otherwise ship an app any
      // local process can relaunch with --inspect. e2eFuses() throws
      // on make/publish rather than silently building either way.
      [FuseV1Options.EnableNodeCliInspectArguments]: e2eFuses(),
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
