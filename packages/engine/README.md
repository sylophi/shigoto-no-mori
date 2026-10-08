# engine

The data model and the store, git, worktrees, landing, doctor and the updater, as Effect services with no Electron import. It replaces the Go CLI in `cli/` and takes `app/host/lib/git`, `projects`, `config`, `worktrees` and `app/shared/git` in step 2 of `V3.md`.

- `src/`: one module per service, named for it (`Store.ts`), shaped as `EFFECT.md` section 2 says, and its pure helpers beside it in lowercase modules.
- `test/`: the tests, run by vitest (`pnpm run check:engine` from the root), one file at a time since they spawn real processes.

The engine runs in the host under Node and in the terminal binary under Bun, so it imports Node's APIs, `effect`, `@effect/*` and `@shigomori/contracts`, and nothing else: no Electron, nothing from the app, no Bun global. `test/boundary.test.ts` holds that, for what the package declares and what its sources import.
