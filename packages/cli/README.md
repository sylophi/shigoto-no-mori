# cli

The terminal `sm`: the entrypoint on `effect/cli` over the engine, compiled with Bun.

- `src/main.ts`: the command tree over Bun's platform. `src/engine.ts` composes the engine's services, the store through `@effect/sql-sqlite-bun` (Bun's SQLite can't load extensions, which the node driver asks for), and the darwin helper (`macfs`) beside the binary.
- `src/here.ts`: where a command runs among the projects, and the project it names (`--project-id`, `-p` or a positional, else the one at the cwd), through the engine's `Worktrees`. Terrier's trouble is a warning there.
- `src/commands/`: one module per verb group. A command decodes its input, calls the engine and prints, as `EFFECT.md` section 1 says.
- `src/prompt.ts`: a yes or no asked on stderr, only at a terminal and never under `--json`.
- `src/handOver.ts`: a program given the terminal (`run`'s script, `cd`'s subshell): signals passed on, and sm ends as it did, dying of its signal (`Killed`, which `main.ts` raises on the way out).
- `src/build.ts`: the flavor and version the build gives this binary.
- `src/output.ts`, `src/errors.ts`: how a command prints, the Go `sm`'s way. `--json` and `--verbose` are global wherever they sit up to a `--`. A failure under `--json` is the engine's error document (`errorDocument`) with `ok: false`, and a person gets `sm: <message>` on stderr. A usage error exits 2, any other 1, and a command that has said all it has to ends with its own code (`ExitCode`).
- `build.mts`: `node build.mts [outfile] [--prod] [--version=<v>]` builds `dist/smd` (dev) or `dist/sm` (prod): Bun bytecode, ad hoc signed.
- `test/`: the built binary on a sandbox data dir: how a command line is refused, a person at a terminal, the shell's config and wrapper, and a script handed the terminal (`pnpm run check:cli` from the root). It needs Bun, and Go for the darwin helper.

