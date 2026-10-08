# cli

The terminal `sm`: the entrypoint on `effect/cli` over the engine, compiled with Bun. It replaces `cli/main.go`, `menu.go`, the pickers, `cmd_shell.go` and `cmd_run.go` in step 2 of `V3.md`.

- `src/main.ts`: the command tree over Bun's platform. `src/engine.ts` composes the engine's services, the store through `@effect/sql-sqlite-bun` (Bun's SQLite can't load extensions, which the node driver asks for), and the darwin helper (`macfs`) beside the binary.
- `src/here.ts`: where a command runs among the projects, and the project it names (`--project-id`, `-p` or a positional, else the one at the cwd), through the engine's `Worktrees`. Terrier's trouble is a warning there.
- `src/commands/`: one module per verb group. A command decodes its input, calls the engine and prints, as `EFFECT.md` section 1 says.
- `src/output.ts`, `src/errors.ts`: how a command prints, the Go `sm`'s way. `--json` and `--verbose` are global wherever they sit up to a `--`. A failure under `--json` is `{ok: false, error, code?}`, and a person gets `sm: <message>` on stderr. An error says itself whether it is a usage error (`usage`, exit 2, else 1) and which code it carries (`jsonCode`).
- `build.mts`: `node build.mts [outfile] [--prod]` builds `dist/smd` (dev) or `dist/sm` (prod): Bun bytecode, ad hoc signed.
- `test/`: the built binary beside the Go `sm` on copies of one sandbox, each verb's exit code, JSON document, output and errors compared (`pnpm run check:cli` from the root). It needs Bun and Go.

