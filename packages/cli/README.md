# cli

The terminal `sm`: the entrypoint on `effect/cli` over the engine, compiled with Bun. It replaces `cli/main.go`, `menu.go`, the pickers, `cmd_shell.go` and `cmd_run.go` in step 2 of `V3.md`.

- `src/main.ts`: the command tree and the process's layer graph: the engine's services over Bun's platform, the store through `@effect/sql-sqlite-bun` (Bun's SQLite can't load extensions, which the node driver asks for).
- `src/commands/`: one module per verb group. A command decodes its input, calls the engine and prints, as `EFFECT.md` section 1 says.
- `src/output.ts`, `src/errors.ts`: how a command prints, the Go `sm`'s way. `--json` and `--verbose` are global wherever they sit up to a `--`. A failure under `--json` is `{ok: false, error, code?}`, and a person gets `sm: <message>` on stderr. A usage error exits 2, any other 1.
- `build.mts`: `node build.mts [outfile] [--prod]` builds `dist/smd` (dev) or `dist/sm` (prod): Bun bytecode, ad hoc signed.
- `test/`: the built binary beside the Go `sm` on copies of one sandbox, each verb's exit code, JSON document, output and errors compared (`pnpm run check:cli` from the root). It needs Bun and Go.

Measured 2026-10-08 on `--json config list` against the Go `sm` built from `cli/`, on a loaded machine: the Go binary is 12.5 MB and starts in 6 to 11 ms, the Bun binary is 69 MB and starts in 33 to 51 ms (about 50 ms without bytecode).
