# cli

The terminal `sm`: the entrypoint on `effect/cli` over the engine, compiled with Bun.

- `src/main.ts`: the command tree over Bun's platform. `src/engine.ts` composes the engine's services, the store through `@effect/sql-sqlite-bun` (Bun's SQLite can't load extensions, which the node driver asks for), and the darwin helper (`macfs`) beside the binary.
- `src/here.ts`: where a command runs among the projects, and the project it names (`--project-id`, `-p` or a positional, else the one at the cwd), through the engine's `Worktrees`. Terrier's trouble is a warning there.
- `src/commands/`: one module per verb group. A command decodes its input, calls the engine and prints, as `EFFECT.md` section 1 says.
- `src/help.ts`: the help, the Go `sm`'s catalog of usage lines, each with its description and detail. A usage line leaves out `-p <project>`, which the prose says once, and a verb's `--json` shape goes in its detail as `{…}`. `src/aliases.ts` folds the aliases before parsing: a worktree verb goes in `WORKTREE_VERBS`, or `sm wt <verb>` reads `<verb>` as a worktree's name and switches to it.
- `src/menu.ts`, `src/menuView.ts` (on ink), `src/pickers.ts`: the menu a command opens when a person at a terminal runs it without naming its target. `src/reporter.ts` and `src/spinner.ts` are a long command's progress on stderr.
- `src/prompt.ts`: a yes or no asked on stderr, only at a terminal and never under `--json`.
- `src/handOver.ts`: a program given the terminal (`run`'s script, `cd`'s subshell): signals passed on, and sm ends as it did, dying of its signal (`Killed`, which `main.ts` raises on the way out).
- `src/build.ts`: the flavor and version the build gives this binary.
- `src/output.ts`, `src/errors.ts`: how a command prints, the Go `sm`'s way. `--json` and `--verbose` are global wherever they sit up to a `--`. A failure under `--json` is the engine's error document (`errorDocument`) with `ok: false`, and a person gets `sm: <message>` on stderr. A usage error exits 2, any other 1, and a command that has said all it has to ends with its own code (`ExitCode`).
- `build.mts`: `node build.mts [outfile] [--flavor=prod|v3|dev] [--version=<v>]` builds `dist/smd` (dev, the default), `dist/smv3` (v3) or `dist/sm` (prod): Bun bytecode, ad hoc signed.
- Adding a verb: its command in `src/commands/`, its line in the catalog (`src/help.ts`), and its registration in `src/main.ts`. A worktree verb is registered twice, under `worktreesCommand` and at the top level, since the prefix is optional, and joins `WORKTREE_VERBS`. The test runs every command the catalog names, in both forms, so a verb the catalog lists and the binary lacks fails it.
- `test/`: the built binary on a sandbox data dir: how a command line is refused, a person at a terminal, the shell's config and wrapper, and a script handed the terminal (`pnpm run check:cli` from the root, or one case with `pnpm -C packages/cli exec vitest run -t <name>`). It needs Bun, and Go for the darwin helper. Its sandbox is the engine's (`../engine/test/lib/sandbox.ts`): a home holding a 2.x data dir, which the first command imports.

