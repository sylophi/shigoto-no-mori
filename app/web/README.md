# web

The web client runs the renderer ([`../renderer`](../renderer)) in a browser tab as a device with no host of its own. Every host it shows is a peer reached over the device link through the hub, and the tab serves only itself in the page.

- [`main.tsx`](main.tsx), [`preload.ts`](preload.ts), [`boot.tsx`](boot.tsx): the page's entry points, mirroring [`main/preload.ts`](../main/preload.ts) and [`renderer/index.tsx`](../renderer/index.tsx) on desktop. [`preload.ts`](preload.ts) creates the bridge and wires page events, then [`boot.tsx`](boot.tsx) runs the renderer's shared boot on the bridge's API with plain `@clerk/react` and real browser history.
- [`ipc/register.ts`](ipc/register.ts): the tab's composition root. It builds the same page API as the desktop over the tab's client runtime from `WebBridgeDeps`, so a check can run it headless. [`ipc/localRegistrar.ts`](ipc/localRegistrar.ts) serves what a tab handles itself (account, client config, hub bridge, shell, releases, and its copy of shared settings), and [`ipc/stubDefaults.ts`](ipc/stubDefaults.ts) responds to local host calls that the web client lacks with schema-derived stubs.
- [`account/`](account/): the build's account service configuration and the browser's device id, name, and icon.
- [`lib/kvStorage.ts`](lib/kvStorage.ts): localStorage wrapped behind a schema.

`pnpm web:dev` (run from `app/`) serves the web client against the dev hub, and signing in requires `.env.local` ([`../lab/dev-app.md`](../lab/dev-app.md)). The fake host's web shell ([`../lab/fake-host`](../lab/fake-host)) renders it over fixtures without a hub, and `pnpm reliability` ([`../lab/reliability`](../lab/reliability)) drives the real web client through outages. Logging uses `log` from [`shared/log.ts`](../shared/log.ts), as everywhere in the app.

## Deploying

The web client is served from `app.shigomori.com`, deployed by Vercel from `web-client-prod` (the project's production branch). At the end of every full (non-prerelease) release, once the desktop assets are uploaded, the release workflow fast-forwards `web-client-prod` to the tagged commit so each release's web client is built from the same commit as its desktop app. Pushing by hand is fine for a web-only fix between releases: the workflow leaves `web-client-prod` alone if it is already ahead of the tag, and fails rather than overwriting a branch that has diverged from the tag.

The CSP ([`../vercel.json`](../vercel.json)) allowlists the Colibrii instance and both Clerk script hosts: `https://*.clerk.accounts.dev` for the development instance and `https://clerk.shigomori.com`, the production instance's own Frontend API host. One static file serves every Vercel environment, so both stay listed.

### The Vercel projects

The web client (`app`) and the marketing site ([`marketing`](../../marketing), deployed from `main`) are each a Vercel project that builds one folder of the pnpm workspace at the repo root, where shared dependencies get their versions from the `catalog:` in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml). Each project's settings hold what its folder's `vercel.json` cannot:

- Root Directory: the folder, with "Include files outside the root directory" enabled, because both install and build read the workspace root and `packages/`.
- The environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so install uses the pnpm version pinned in the root [`package.json`](../../package.json) (`packageManager`).
- For the web client, the account settings ([`../ACCOUNT.md`](../ACCOUNT.md)), which its build bakes in.

Each `vercel.json` sets the install command, `pnpm install --no-frozen-lockfile --ignore-scripts`, alongside the build settings and headers. Neither build needs an install script. With scripts enabled, the app's `postinstall` runs twice concurrently (its own and the root's), and the two node-pty builds clear each other's `build/` folder.
