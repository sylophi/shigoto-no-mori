# web

The web client: the renderer (`../renderer`) in a browser tab, a
device with no host of its own. Every host it shows is a peer, reached
over the device link through the hub, and it serves only itself, in the
page.

- `main.tsx`, `preload.ts`, `boot.tsx`: the page's entry. `preload.ts`
  installs the bridge on `window.api` before any renderer module
  evaluates (several read it at module scope), then `boot.tsx` runs the
  renderer's shared boot with plain `@clerk/react` and real browser
  history. The twins of `main/preload.ts` and `renderer/index.tsx`.
- `ipc/register.ts`: the tab's composition root. It builds the same
  `window.api` the desktop does over the tab's client runtime, from
  `WebBridgeDeps`, so a check can run it headless.
  `ipc/localRegistrar.ts` serves what a tab serves itself (the account,
  the client config, the hub bridge, the shell, the releases, its copy
  of the shared settings); `ipc/stubDefaults.ts` answers a local host
  call it lacks with a schema-derived stub.
- `hub/`: the tab's hub socket (`connection.ts`), and its trace
  (`trace.ts`): a console line per phase change, the web client's only
  log.
- `account/`: the browser's credential store, device id, name and icon.
- `lib/kvStorage.ts`: localStorage behind a schema.

`pnpm web:dev` (from `app/`) serves it against the dev hub; signing in
needs `.env.local` (`../lab/dev-app.md`). The fake host's web shell
(`../lab/fake-host`) draws it over the fixtures without a hub, and
`pnpm reliability` (`../lab/reliability`) drives the real one through
outages. Logging is `shared/log.ts`'s `log`, as everywhere in the app.
