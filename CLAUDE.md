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
  APIs; they consume `window.api` and TanStack Query as before.
- `shared/` may import `effect` but never `@effect/platform-node`; only
  `host/` and `main/` may (the host-boundary check enforces the rest).
- Service ids are `"sm/<area>/<Name>"`. A service's primary layer is
  `static readonly layer`; variants are `layerTest`, `layerNoDeps`.
- Errors that cross a wire are `Schema.TaggedError` classes declared in
  `shared/errors.ts`. Transports carry the tag and fields beside the
  message (`shared/ipc/wireError.ts`); matchers read the tag, never the
  prose. Every wire change stays additive (optional field, message
  fallback) because a user's devices run mixed app versions.
- Imports from `effect/unstable/*` are confined to adapter files, since
  the stable release drops the `unstable` segment.
- Bridge into Effect with `runtime.runPromise(effect, { signal })` at
  the non-Effect edge (`main/runtime.ts`), nowhere else.
