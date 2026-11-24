# web

The web client: the renderer (`../renderer`) in a browser tab, a
device with no host of its own. Every host it shows is a peer, reached
over the device link through the hub, and it serves only itself, in the
page.

- `main.tsx`, `preload.ts`, `boot.tsx`: the page's entry. `preload.ts`
  makes the bridge and wires the page's events, then `boot.tsx` runs
  the renderer's shared boot on the bridge's api with plain
  `@clerk/react` and real browser history. The twins of
  `main/preload.ts` and `renderer/index.tsx`.
- `ipc/register.ts`: the tab's composition root. It builds the same
  page api the desktop does over the tab's client runtime, from
  `WebBridgeDeps`, so a check can run it headless.
  `ipc/localRegistrar.ts` serves what a tab serves itself (the account,
  the client config, the hub bridge, the shell, the releases, its copy
  of the shared settings), and `ipc/stubDefaults.ts` answers a local
  host call it lacks with a schema-derived stub.
- `account/`: the build's account service configuration, and the
  browser's device id, name and icon.
- `lib/kvStorage.ts`: localStorage behind a schema.

`pnpm web:dev` (from `app/`) serves it against the dev hub, and signing
in needs `.env.local` (`../lab/dev-app.md`). The fake host's web shell
(`../lab/fake-host`) draws it over the fixtures without a hub, and
`pnpm reliability` (`../lab/reliability`) drives the real one through
outages. Logging is `shared/log.ts`'s `log`, as everywhere in the app.

## Deploying

The web client is served from `app.shigomori.com`, deployed by Vercel
from the `web-client-prod` branch, the project's production branch.
The release workflow fast-forwards that branch to the tagged commit at
the end of every full (non-prerelease) release, once the desktop assets
are uploaded, so a release's web client is built from the commit its
desktop app is. A push by hand is fine for a web-only fix between releases: the
workflow leaves a branch that is already past the tag alone, and goes
red rather than overwrite one that has diverged from it.

The CSP (`../vercel.json`) allowlists the Colibrii instance and both
Clerk script hosts: `https://*.clerk.accounts.dev` for the development
instance and `https://clerk.shigomori.com`, the production instance's
own Frontend API host. One static file serves every Vercel environment,
so both stay listed.

### The Vercel projects

The web client (`app`) and the marketing site (`marketing`, deployed
from `main`) are each a Vercel project that builds one folder of the
pnpm workspace at the repo root, whose shared dependencies take their
versions from the `catalog:` in `pnpm-workspace.yaml`. Each project's settings
hold what its folder's `vercel.json` can't:

- Root Directory: the folder, with "Include files outside the root
  directory" on, since the install and the build read the workspace
  root and `packages/`.
- The environment variable `ENABLE_EXPERIMENTAL_COREPACK=1`, so the
  install runs the pnpm the root `package.json` pins
  (`packageManager`).
- For the web client, the account settings (`../ACCOUNT.md`), which
  its build bakes in.

Each `vercel.json` holds the install command, `pnpm install
--no-frozen-lockfile --ignore-scripts`, beside the build settings and
the headers. Neither build needs an install script. With scripts on,
the app's `postinstall` runs twice at once (its own and the root's),
and the two node-pty builds clear each other's `build/` folder.
