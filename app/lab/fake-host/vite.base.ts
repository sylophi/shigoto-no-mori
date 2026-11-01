// Everything the two fake host flavors share (vite.config.ts for the
// desktop renderer tree, vite.web.config.ts for the web shell) on top of
// the renderer tree's base (vite.rendererTree.ts), parameterized by the
// two things that actually differ, and the pieces the marketing site's
// build takes too. Its own module rather than named exports beside a
// default one, which vite's config bundler warns about.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_APP_VERSION } from "@shigomori/ui/fixtures/fixtures.ts";
import { mergeConfig, type UserConfig } from "vite";
import {
  rendererTreeAliases,
  rendererTreeConfig,
} from "../../vite.rendererTree";
import { fixedDevServerPort } from "../../scripts/lib/portsEnvFile.mts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");

// Each flavor's own prebundle cache, as the web client has
// (vite.web.config.ts): sharing one, a flavor starting re-optimizes
// over the other's, whose page then asks for deps it has replaced.
const CACHE_DIRS = {
  FAKE_HOST_PORT: ".vite-fake-host",
  FAKE_HOST_WEB_PORT: ".vite-fake-host-web",
} as const;

// Clerk's two flavors on the in-memory stub, so the account UI renders
// signed in without a network.
const clerkStubAliases = {
  "@clerk/electron/react": resolve(here, "clerkStub.tsx"),
  "@clerk/react": resolve(here, "clerkStub.tsx"),
};

// What any build of the renderer tree over the fixtures needs, the fake
// host's and the marketing site's live frames (frames.tsx): the app's
// aliases, the Clerk stub and the build info.
export const fixtureAliases = { ...clerkStubAliases, ...rendererTreeAliases };

export const fixtureDefine = {
  __APP_VERSION__: JSON.stringify(FAKE_APP_VERSION),
  __APP_COMMIT__: JSON.stringify("fake-host"),
};

export function fakeHostBaseConfig(opts: {
  // Its port's key in .env.ports, so each worktree gets its own.
  portKey: "FAKE_HOST_PORT" | "FAKE_HOST_WEB_PORT";
  // The HTML entry vite pre-bundles deps from: the desktop fake host's
  // index.html, the web shell's web.html.
  entry: string;
}): UserConfig {
  return mergeConfig(rendererTreeConfig({ root: here, entry: opts.entry }), {
    resolve: { alias: clerkStubAliases },
    server: {
      port: fixedDevServerPort(opts.portKey),
      strictPort: true,
    },
    cacheDir: resolve(appRoot, "node_modules", CACHE_DIRS[opts.portKey]),
    define: fixtureDefine,
  });
}
