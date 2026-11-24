# The repo's lint rules

An oxlint plugin ([`shigomori.mts`](shigomori.mts), loaded by [`.oxlintrc.json`](../.oxlintrc.json)), with one rule per file in [`rules/`](rules/).

| Rule | What it enforces |
| --- | --- |
| `no-double-cast` | No `x as unknown as T`. |
| `no-native-tooltip` | No `title` on a DOM element and no SVG `<title>` (use SimpleTooltip instead). |
| `no-native-choice` | No `<input type="checkbox">` or `<input type="radio">` (use Checkbox, Switch, OptionCard, or SegmentedControl instead). |
| `ui-words` | Strings and JSX text in `packages/ui/src` and `app/renderer` must follow the spellings in [`app/DESIGN.md`](../app/DESIGN.md)'s "Words", and must not type a key glyph literally (the keymap or `lib/keys.ts` supplies it). |
| `disable-needs-reason` | Every suppression must explain why: `-- <reason>` after an oxlint or eslint directive, or text after a `@ts-expect-error`, `@ts-ignore`, or `@ts-nocheck`. |
| `effect-namespace-imports` | Effect modules must be imported as namespaces from their subpath, e.g. `import * as Effect from "effect/Effect"`. |
| `no-runtime-in-service` | A service module never builds a `ManagedRuntime` or calls `run*`. |
| `no-node-builtins-in-service` | A service module never imports `node:fs`, `node:child_process`, `node:os`, or `node:path`. |
| `no-env-in-service` | A service module reads the environment through `Config`, never `process.env`. |
| `no-wall-clock` | Time must come through `Clock` or `DateTime`, never `Date.now()` or `new Date()`: applies in any service module anywhere, and in every non-test module of `app/shared`, `app/host`, `app/main`, `packages/engine`, `packages/contracts`, and `packages/cli`. |
| `no-process-platform` | The OS may be read only in [`packages/engine/src/platform.ts`](../packages/engine/src/platform.ts) (`current`, `byFamily`, `byPlatform`, `byHostKind`), never via `process.platform` or `os.platform()`: applies in every non-test module of `app/shared`, `app/host`, `app/main`, `app/headless`, and each package's `src`. |
| `effect-fn-service-methods` | Any method that a service module's tag types as returning an `Effect.Effect` must be implemented with `Effect.fn("Service.method")`, not a plain function. |

`pnpm run lint` also runs [`app/scripts/react-compiler-check.mts`](../app/scripts/react-compiler-check.mts), which fails on any component or hook in `app/renderer` or `packages/ui/src` that the React Compiler skips, printing the file, function, and compiler reason. Known bailouts are listed in [`app/scripts/react-compiler-bailouts.json`](../app/scripts/react-compiler-bailouts.json) to be fixed and removed.

## Service modules

A service module is a `.ts` or `.mts` file named for its service in PascalCase, matching [`EFFECT.md`](../EFFECT.md) (for example, `Registry.ts`, `GitWatcher.mts`). Regardless of where it lives, that PascalCase filename is what makes the service rules apply ([`serviceModule.mts`](serviceModule.mts)). Test files (`Registry.test.ts`), declaration files, and all lowercase modules (helpers, layer graphs, and adapters at the edge) are not service modules, so they may run effects and touch the platform directly.

## Adding a rule

Add `rules/<name>.mts`, register it in [`shigomori.mts`](shigomori.mts), and enable it in [`.oxlintrc.json`](../.oxlintrc.json). Declare the AST nodes the rule reads in [`types.mts`](types.mts), since oxlint keeps its plugin types internal.
