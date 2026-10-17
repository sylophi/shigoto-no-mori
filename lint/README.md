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
| `no-env-in-service` | A service module reads the environment through `Config`, never `process.env`. |
| `no-wall-clock` | The time comes through `Clock` or `DateTime`, never `Date.now()` or `new Date()`: in a service module anywhere, and in every module of `app/shared`, `app/host`, `app/main`, `packages/engine` and `packages/contracts` but their tests. |
| `effect-fn-service-methods` | A method a service module's tag types as returning an `Effect.Effect` is `Effect.fn("Service.method")`, not a plain function. |

`pnpm run lint` also runs `app/scripts/react-compiler-check.mts`,
which fails on a component or hook in `app/renderer` or
`packages/ui/src` that the React Compiler skips, printing the file,
the function and the compiler's reason. The ones it skipped when the
check came are listed in `app/scripts/react-compiler-bailouts.json`,
to be fixed and taken off.

## Service modules

A service module is a `.ts` or `.mts` file named for its service in
PascalCase, as `EFFECT.md` names them: `Registry.ts`, `GitWatcher.mts`.
Wherever it lives, that name is what makes the service rules apply
(`serviceModule.mts`). A test (`Registry.test.ts`), a declaration file,
and every lowercase module (a helper, a layer graph, an adapter at the
edge) are not service modules, so they may run effects and touch the
platform directly.

## Wall-clock reads left to the time hardening

`.oxlintrc.json` turns `no-wall-clock` off for the files whose
`Date.now()` the time-and-liveness hardening is replacing, each taken
off the list by the pull request that changes it:

- Durable facts and process identity: `app/main/hostProcess.ts`,
  `packages/engine/src/worktrees/moving.ts`.
- In-memory TTLs and small gates:
  `app/host/lib/githubCli/pullRequests.ts`,
  `app/host/lib/sync/sourceLink.ts`, `app/host/mirror/gitFollow.ts`,
  `app/main/electron/liveness.ts`,
  `app/main/electron/notifications.ts`, `app/shared/hub/link.ts`.

## Adding a rule

Add `rules/<name>.mts` and `rules/<name>.test.mts`, register it in
`shigomori.mts`, and turn it on in `.oxlintrc.json`. A rule declares the
AST it reads in `types.mts`, since oxlint keeps its plugin types
internal.
