# engine

The data model and the store, git, worktrees, landing, the cross-device verbs, doctor and the updater, as Effect services with no Electron import. It replaces the Go CLI in `cli/` and takes `app/host/lib/git`, `projects`, `config`, `worktrees` and `app/shared/git` in step 2 of `V3.md`.

- `src/`: one module per service, named for it (`Store.ts`), shaped as `EFFECT.md` section 2 says, and its pure helpers beside it in lowercase modules. Consumers import a module by its name: `@shigomori/engine/Store`.
- `src/layer.ts`: the engine's layer graph (`engineLayer`), built once per process by the terminal, the host and the parity sandbox.
- `src/migrations/`: the store's schema history, which `Store` runs on open.
- `src/data/`: the data the engine ships with: the launcher catalog and the worktree name pools. They match `cli/embed`, which the Go `sm` embeds until the switch-over (`test/data.test.ts`).
- `test/`: the tests, run by vitest (`pnpm run check:engine` from the root). `test/parity.test.ts` is the parity harness: each verb the engine can answer runs as the Go `sm --json` (built from `cli/`) and as the engine's service call against copies of one sandbox, and the two documents must match, since the CLI's JSON is frozen.

The store is one SQLite database in the data dir (`store.db`, WAL), opened by the engine only and by one connection per process. Its first open imports the JSON files a 2.x data dir keeps and leaves them in place.

The engine runs in the host under Node and in the terminal binary under Bun, so it imports Node's APIs, `effect`, `@effect/*` and `@shigomori/contracts`, and nothing else: no Electron, nothing from the app, no Bun global. `test/boundary.test.ts` holds that for its sources.
