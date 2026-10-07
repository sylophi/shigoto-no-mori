# The repo's lint rules

An oxlint plugin (`shigomori.mts`, loaded by `.oxlintrc.json`), one
rule per file in `rules/`, each with a vitest test beside it that runs
its cases through oxlint's `RuleTester`.

| Rule | What it holds |
| --- | --- |
| `no-double-cast` | No `x as unknown as T`. |
| `no-native-tooltip` | No `title` on a DOM element and no SVG `<title>`; SimpleTooltip instead. |
| `disable-needs-reason` | Every suppression says why: `-- <reason>` after an oxlint or eslint directive, text after a `@ts-expect-error`, `@ts-ignore` or `@ts-nocheck`. |
| `effect-namespace-imports` | Effect modules come in as namespaces from their subpath, `import * as Effect from "effect/Effect"`. |
| `no-runtime-in-service` | A service module never builds a `ManagedRuntime` or calls `run*`. |
| `no-node-builtins-in-service` | A service module never imports `node:fs`, `node:child_process`, `node:os` or `node:path`. |

## Service modules

A service module is a `.ts` or `.mts` file named for its service in
PascalCase, as `EFFECT.md` names them: `Registry.ts`, `GitWatcher.mts`.
Wherever it lives, that name is what makes the two service rules apply
(`serviceModule.mts`). A test (`Registry.test.ts`), a declaration file,
and every lowercase module (a helper, a layer graph, an adapter at the
edge) are not service modules, so they may run effects and touch the
platform directly.

## Adding a rule

Add `rules/<name>.mts` and `rules/<name>.test.mts`, register it in
`shigomori.mts`, and turn it on in `.oxlintrc.json`. A rule declares the
AST it reads in `types.mts`, since oxlint keeps its plugin types
internal.
