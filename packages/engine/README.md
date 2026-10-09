# engine

The data model and the store, git, worktrees, landing, the cross-device verbs, doctor and the updater, as Effect services with no Electron import. The terminal `sm` (`packages/cli`) and the app's host both run it, on one store.

- `src/`: one module per service, named for it (`Store.ts`), shaped as `EFFECT.md` section 2 says, and its pure helpers beside it in lowercase modules. Consumers import a module by its name: `@shigomori/engine/Store`.
- `src/layer.ts`: the engine's layer graph (`engineLayer`), built once per process by the terminal, the host and the test sandbox.
- `src/migrations/`: the store's schema history, which `Store` runs on open.
- `src/data/`: the data the engine ships with: the launcher catalog and the worktree name pools.
- `test/`: the tests, run by vitest (`pnpm run check:engine` from the root). `test/lib/sandbox.ts` gives each test a home holding a 2.x data dir, and the engine on its own copy.

The store is one SQLite database in the data dir (`store.db`, WAL), opened by the engine only and by one connection per process. Its first open imports the JSON files a 2.x data dir keeps and leaves them in place.

The engine runs in the host under Node and in the terminal binary under Bun, so it imports Node's APIs, `effect`, `@effect/*` and `@shigomori/contracts`, and nothing else: no Electron, nothing from the app, no Bun global. `test/boundary.test.ts` holds that for its sources.
