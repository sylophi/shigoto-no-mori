# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Effect in this repo

The migration plan and its phases are in `EFFECT-MIGRATION.md`. The rules
that hold across all of them:

- Effect runs on the Node side (`host/`, `main/`) and in the browser-safe
  cores under `shared/`. `renderer/` components and hooks never call Effect
  APIs. They consume `window.api` and TanStack Query as before.
- `shared/` may import `effect` but never `@effect/platform-node`. Only
  `host/` and `main/` may (the host-boundary check enforces the rest).
- Service ids are `"sm/<area>/<Name>"`. A service's primary layer is
  `static readonly layer`. Variants are `layerTest`, `layerNoDeps`.
- Errors are `Schema.TaggedError` classes. One the renderer matches on
  is declared in `shared/errors.ts` beside its matcher and tag
  constant. One only its own module raises lives beside that module
  (`GitError` in `host/lib/git/core.ts`). Transports carry the tag and
  fields beside the message (`shared/ipc/wireError.ts`). Matchers read
  the tag, never the prose, and `_tag` is an own property of the
  instance, not of the prototype. Every wire change stays additive
  (optional field, message fallback) because a user's devices run mixed
  app versions.
- Imports from `effect/unstable/*` are confined to adapter files, since
  the stable release drops the `unstable` segment.
- Bridge into Effect with `runtime.runPromise(effect, { signal })` at
  the non-Effect edge (`main/runtime.ts`). A runner that must start and
  stop synchronously from Promise-side code (the supervisor, the
  keeper, the mirror daemon, the watchers) forks with `Effect.runFork`
  behind a `runtime` seam until AppLive owns it (Phase 2 step 7). A
  throw from an owner callback inside such a fiber must be contained
  and logged, since a defect in a forked fiber is reported nowhere.
