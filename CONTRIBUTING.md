# Contributing

The rules of the road, for people and for agents. The README maps the
tree, `MANUAL-TESTING.md` covers exercising the app by hand, and this
file is what is easy to get wrong on a first change.

## Setup

You need Node 22.18 or newer, pnpm (the version `package.json` pins),
Go (for `cli/` and `file-sync/`), and
[port-pool](https://github.com/dittofleet/port-pool) on your PATH for
`pnpm dev`.

```sh
pnpm install
pnpm dev                      # the desktop app, as the dev flavor
pnpm dev --profile <name>     # an isolated extra instance (own data dir)
pnpm web:dev                  # the browser client
pnpm exec vite --config lab/vite.config.ts   # the UI lab, no backend
```

If your pnpm ignores lifecycle scripts, `postinstall` did not run. Run
its two steps once by hand, or file icons go missing and anything that
opens a PTY fails with `posix_spawnp failed`:

```sh
node scripts/copy-material-icons.mjs && node scripts/fix-node-pty-helper.mjs
```

## Checking your work

```sh
pnpm typecheck && pnpm lint && pnpm format:check
pnpm test                     # lists the proofs in test/
pnpm test socket-host         # runs one
pnpm exec lefthook run pre-commit --all-files   # everything
```

The pre-commit hook runs the first line on every commit, and each proof
in `test/` only when a file it covers changed. `lefthook.yml` holds
those file lists, so it is also the quickest way to learn what a proof
covers.

Nothing under `renderer/` has an automated test. Verify UI changes by
looking: the UI lab poses most multi-device states without a second
machine (`lab/README.md`), and a dev profile gives you the real app
against a real disk without touching your own data.

## Where code goes

- **`host/`** is what a device serves: projects, worktrees, git,
  scripts. No Electron and no imports from `main/`.
- **`main/`** is the desktop binding. `main/electron/` wraps Electron
  and the OS. The other folders there are Electron free on purpose, so
  a plain node proof can drive them. Keep them that way.
- **`web/`** is the browser binding, under the same rules as `host/`.
- **`shared/`** is what every side compiles. It must load in a browser,
  in node and in a Worker, so no Electron and no node builtins, except
  under `shared/packaging/`, which is node only and never imported by
  the renderer.
- **`renderer/components/ui`** holds primitives, which fetch nothing.
  **`components/shared`** holds app-aware pieces several features use.
  Every other folder under `components/` is one feature and mostly
  keeps to itself. When several need the same piece, move it to
  `shared/`, or to a folder of its own beside them (see
  `worktreeDetail/flow/`), rather than reaching into a sibling.

`pnpm test host-boundary` enforces the Electron and `main/` import rules
for `host/`, `shared/` and `web/`. The rest is on you and your reviewer.

A file is `.mts` rather than `.ts` when a plain `node scripts/x.mjs`
must load it with no loader. Import those with the extension
(`@shared/git/repoIdentity.mts`), and everything else without.

## Adding an IPC channel

1. Declare it in `shared/ipc/modules/<area>.ts`. A new module picks a
   side with `defineContract("host" | "client", ...)`: `host` for what
   a device serves, which peers can call too, and `client` for what
   only the window showing the UI can do.
2. Handle it in `host/ipc/modules/` (host) or `main/ipc/modules/`
   (client).
3. Expose it from `buildApi` in `shared/ipc/client.ts`.
4. The web client and the UI lab answer unhandled channels with a stub
   derived from the output schema (`web/ipc/stubDefaults.ts`), so check
   the feature degrades sensibly there.

A host read that peers may call without the command grant changes the
golden file. If that is deliberate, regenerate it with
`pnpm test socket-host --update` and commit the diff.

## Adding a proof

Add `test/<name>.mjs`, a standalone script that exits non-zero on
failure (`test/lib/checkKit.mjs` has the reporting and fixtures), and a
job of the same name in `lefthook.yml` whose glob lists the files it
covers. `test/worktree-ports.mjs` is the smallest example.

## Conventions

- The React Compiler memoizes. `useMemo`, `useCallback` and `memo` are
  lint errors.
- Comments say why, not what, and wrap at 72 columns. There are no
  TODO comments: fix it or file it.
- A rule that lives in both TypeScript and Go (`shared/git/` and its
  twins in `cli/`) names its twin in a comment. Change both.
- If you change how the installer window looks (`renderer/doubutsu.css`,
  `scripts/dmg-background.html`, `shared/packaging/dmgLayout.mts`),
  re-render the art with `pnpm dmg:background` and commit it.
  `pnpm test dmg-art` tells you when you forgot.
