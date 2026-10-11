# engine

The data model and the store, git, worktrees, landing, the cross-device verbs, doctor and the updater, as Effect services with no Electron import. The terminal `sm` (`packages/cli`) and the app's host both run it, on one store.

- `src/`: one module per service, named for it (`Store.ts`), shaped as `EFFECT.md` section 2 says, and its pure helpers beside it in lowercase modules. Consumers import a module by its name: `@shigomori/engine/Store`.
- `src/worktrees/`, `src/doctor/`, `src/git/`, `src/updater/`, `src/landing/`: the five largest services, each split by area into sub-makers that its module's `make` composes (`EFFECT.md`, section 2). An area's file says what it covers; `documents.ts` holds the errors, documents and helpers the areas share, which the service module re-exports, so a consumer still imports `@shigomori/engine/Worktrees`.
- `src/goJson.ts`: JSON from another program (gh, the app's control answers) read as Go read it, a field absent or null at its zero value.
- `src/layer.ts`: the engine's layer graph (`engineLayer`), built once per process by the terminal, the host and the test sandbox.
- `src/migrations/`: the store's schema history, which `Store` runs on open.
- `src/data/`: the data the engine ships with: the launcher catalog and the worktree name pools.
- `test/`: the tests, run by vitest (`pnpm run check:engine` from the root, one file with `pnpm -C packages/engine exec vitest run test/<File>.test.ts`). `test/lib/sandbox.ts` gives each test a home holding a 2.x data dir, and the engine on its own copy (`box.engine(effect)` runs an effect on it); `test/lib/gitRepos.ts` makes throwaway repos for the tests of `Git` alone.

A setting is described once, in the contracts: its key and type in `ShigomoriConfigSchema` (`packages/contracts/src/schemas/config.ts`) for a project or `DeviceSettingsPatchSchema` for the device, and its default, when it has one, in `PROJECT_CONFIG_DEFAULTS` (`projectConfigDefaults.ts`, whose type lists every defaulted key) or `DEVICE_SETTINGS_DEFAULTS` beside its schema. `src/Config.ts` reads and writes them, and its `deviceKeys` and `projectKeys` give the order `sm config list` shows them in; a key missing there lists last. The description beside each key in that listing is its field's (`annotateKey({ description })`), which `packages/contracts/test/settings.test.ts` requires of every key.

Paths are per flavor (`src/flavor.ts`): prod, test (a `-test.N` prerelease run beside prod) and dev each have their own data dir (`~/.sm`, `~/.smt`, `~/.smd`), pointer file under `~/.config/<configDir>`, command and alias, scheme, bundle id and update line, so two builds on one machine never share a file. `src/Paths.ts` finds the flavor's data dir: `SHIGOMORI_DATA_DIR`, then the pointer file, then a pre-2.0 folder still holding state (prod and dev only), then the default. The table is the one place these names are spelled; the app's packaging, the terminal's build and the release workflow read it.

Worktrees live under `wt/`: `<dataDir>/wt/<project>`, `<project>/.shigomori/wt`, or the drive's `<dataDirName>/wt/<project>` (`src/worktreeLayout.ts`). Why `wt`: a short folder keeps the paths agents and people read and type all day short. The store's migration moved v2's `worktrees/` folders there once (`src/migrations/wtFolder.ts`, `src/WtFolder.ts`).

The v3 migration reports as it goes (`src/Migration.ts`): what this start owes a 2.x data dir (the import, the move into `wt/`) and each step's state, the move's count and the worktree on the move, and the ones that stayed with git's reason. The store reports its import as it opens and `WtFolder` each move, so a process that builds `Migration` first can show the migration while the store is still opening; the counts are read from the store, so a start after a crash resumes the count. The app's window shows it on a page of its own, and the terminal says one line per step.

The store is one SQLite database in the data dir (`store.db`, WAL), opened by the engine only and by one connection per process. Its first open imports the JSON files a 2.x data dir keeps and leaves them in place. The import reads what the last v2 release wrote; an older data dir upgrades through v2 first.

The engine runs in the host under Node and in the terminal binary under Bun, so it imports Node's APIs, `effect`, `@effect/*` and `@shigomori/contracts`, and nothing else: no Electron, nothing from the app, no Bun global. `test/boundary.test.ts` holds that for its sources.
