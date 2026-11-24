# Effect conventions

These rules govern how Effect is written across every TypeScript package in this repo: the engine, the host, the desktop and web shells, the contracts, the hub, and the renderer's data layer. Code reviews enforce these rules on the lines a PR changes, not on untouched older code. The shell's Electron-facing modules (the menu, windows, and deep links) stay plain Electron code. [`app/main/README.md`](app/main/README.md) documents which parts of the shell use Effect.

Effect is pinned to one exact version, the latest stable release, in the workspace catalog, and a version bump is a PR of its own. Wrap gaps in Effect on our side. Patch Effect itself only for a bug no wrapper can reach, because much of what this repo uses is unstable and every patch has to be redone against each release. Any patch must name the upstream issue or fix, and is removed in the version bump that includes the fix.

Before writing Effect code, read Effect's own guidance for the pinned version:

- `AGENTS.md` in the installed package (`node_modules/effect` in any workspace package, such as `app/node_modules/effect/AGENTS.md`)
- The `ai-docs/` examples linked beside it
- For Schema, `SCHEMA.md` at the pinned tag (`https://github.com/Effect-TS/effect/blob/effect@4.1.4/packages/effect/SCHEMA.md`, a long guide to read in chunks, whose tag moves with the catalog)

This file covers what the repo decides beyond Effect's guidance, and explains why wherever it departs from it. The installed source of that version, in the same `node_modules/effect` folder, is the authoritative reference for any API question. All of this guidance and source is read-only, and it beats memory and any other copy of Effect's docs.

In this pinned version, `rpc`, `socket`, `process`, `cli`, `http`, and `sql` are marked `@stability unstable`. Never write a pattern on those modules from memory. Read their source first.

## 1. Where a capability lives

- A capability is a method on the service that owns its domain (`engine/worktrees`, `host/mirror`, ...). Extend the service that owns the domain, and add a new service only when none owns it.
- Keep transports thin: RPC handlers, terminal commands, shell bridge methods, and MCP tools (`sm guide mcp`). Each transport decodes its input, calls one service method, and maps the service's typed errors to the transport's errors. Filesystem, git, process, or store work, as well as multi-step dispatch, retries, and rollback, belong in the service.
- The reason is reach: the app, the terminal `sm`, a peer device, and tests all call the same service method. Logic written inside one handler is missing from the rest, and testing it requires a wire.
- A workflow over state that only the host holds (scripts, terminals, mirrors) belongs in a host service rather than being pushed into the engine for uniformity.
- Handlers add no spans or metrics of their own. Group middleware authorizes and instruments every call. Add per-call context with `Effect.annotateCurrentSpan`.
- Pure helpers (a slug, a label, layout math) are plain functions beside the service. The capability itself stays a method on the service.

## 2. The shape of a service module

Use one module per service, in this order: imports, errors and schemas, the `Context.Service` tag with its interface inline, `make`, and `layer`.

```ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class RegistryWriteError extends Schema.TaggedError<RegistryWriteError>()(
  "RegistryWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not write the project registry.";
  }
}

export class Registry extends Context.Service<
  Registry,
  {
    readonly write: (input: {
      readonly path: string;
    }) => Effect.Effect<void, RegistryWriteError>;
  }
>()("sm/engine/Registry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // ...
  return Registry.of({ write });
});

export const layer = Layer.effect(Registry, make);
```

- **Imports are namespaces from subpaths:** write `import * as Effect from "effect/Effect"`, never `import { Effect } from "effect"`. Consume a service module the same way: `import * as Registry from "./Registry.ts"`, then use `yield* Registry.Registry` and `Registry.layer`. Named imports are fine for pure helpers, errors, schemas, and types. Effect's guidance imports from `"effect"`, but this repo enforces the subpath namespace form via `effect-namespace-imports`.
- **No standalone interface name.** Refer to the service type as `Registry["Service"]`.
- **Dependencies come from the environment** (`yield* FileSystem.FileSystem`), never as parameters to `make`, and never from a module global or a closure over a singleton. Configuration, immutable values, and deliberate callbacks may be passed as parameters, since they are not services.
- **`make` is private** unless another module needs it. Use the constructor that fits: `Layer.succeed` or `Layer.sync` for a service with no effects, `Layer.effect` for one built with effects, and a scoped constructor for one that owns a resource (section 5).
- **The layer is the module's export**, not a `static layer` on the tag (a departure from Effect's guidance). A service split across sub-makers needs `make` separate from the tag, and exporting `layer` keeps every service reading the same way.
- **Functions:** use `Effect.gen` inline. For a reusable function, use `Effect.fn("name")` where a span helps (every service method) and `Effect.fnUntraced` otherwise (a helper or a hot path). Use `Effect.fn.Return<A, E>` to state a return type that no tag supplies. Pass combinators to `Effect.fn` as further arguments rather than chaining `.pipe`, and do not write a function whose only body is an `Effect.gen`. Fail with `return yield* new SomeError(...)`.
- **Configuration with a default** is a `Context.Reference`.
- **Data from outside** (a file, a wire, or a process's output) must be decoded with Schema, never with `JSON.parse` plus a cast or a hand-made guard. For runtime checks on values, use `Predicate`, never a hand-written `isRecord` or `typeof x === "object" && x !== null`.
- **Tag names** follow `sm/<package>/<Service>`.
- **Moving a service** updates every consumer directly. Do not leave re-export shims.
- **Splitting a large service:** when a service is too big to hold in one file, split it across a few modules by area in a folder named for the service beside its module (for example, `Worktrees.ts`, then `worktrees/listing.ts` and `worktrees/creating.ts`). Each area exports a sub-maker: an `Effect.gen` that yields the services it needs from the environment, takes whatever an earlier area built for it as a parameter, and returns that area's methods. The service's `make` runs the sub-makers in dependency order and composes `Service.of` from what they return.

  Keep the tag, `make`, and `layer` in the main service module. Place errors, documents, and helpers shared across areas inside the same folder (`worktrees/documents.ts`), so no area imports the service module back. The main service module re-exports what consumers use so it remains the single place they import. A sub-maker has no tag and no layer, and nothing outside the service imports it.

  ```ts
  // worktrees/listing.ts
  export const makeListing = Effect.gen(function* () {
    const git = yield* Git.Git;
    const registry = yield* Registry.Registry;
    const list = Effect.fn("Worktrees.list")(function* (/* ... */) {});
    return { list, identities };
  });

  // Worktrees.ts
  const make = Effect.gen(function* () {
    const listing = yield* makeListing;
    const creating = yield* makeCreating({ listing });
    return Worktrees.of({ ...listing, ...creating });
  });
  ```

## 3. Runtime boundaries

- `ManagedRuntime.make`, `Effect.runPromise`, `runPromiseExit`, and their kin belong only at the edges: React, Electron callbacks, the terminal entrypoint, and tests. Never call them inside a service, a store module, or a constructor.
- Each process composes one layer graph per subsystem in its own module: the engine's, the host's, the shell's, and the terminal's. No module builds a runtime to hand out, and no feature gets a runtime of its own.
- Each renderer client (a desktop window, a web client tab, or the lab's fake host) is one `ManagedRuntime` over its links ([`app/renderer/lib/runtime`](app/renderer/lib/runtime)), built when the page boots and disposed when the page closes. All of its calls, views, and pushes run on that runtime, so a view's fiber is interrupted when its subscriber stops and nothing outlives the page.
- A host handler returns an effect over the services in the host's layer graph ([`app/host/process/services.ts`](app/host/process/services.ts)), and a view reads with an effect over those services (`Views.view`). Each handler table uses `satisfies` against the contract's `Handlers`, so every method keeps its own type for in-host callers. `HostRpc.handlers` ([`app/host/socket/hostRpc.ts`](app/host/socket/hostRpc.ts)) turns a module's handler tables into the layer served by the loopback and the device link, running each incoming call on the host's graph as it exists when the call arrives.
- The host's composition root bridges callbacks handed to non-Effect code (device calls and the account fan-out) into its graph through one entry point, [`app/host/process/graph.ts`](app/host/process/graph.ts). It layers on top of the graph so a run started before every service is up waits for startup, and a run started after the graph closes is rejected. Nothing outside [`app/host/process/`](app/host/process/) uses it. Proofs bring the host's services up per test file ([`app/test/lib/hostRuntime.mts`](app/test/lib/hostRuntime.mts)) and run effects on them with `runHost`.

## 4. Errors

- Define failures as `Schema.TaggedError` classes with structured fields: the operation or stage, the path or id, and a category. Build `message` as a fixed string or from those fields, never from `cause.message` or a stringified defect.
- A wrapped failure stores the underlying error in `cause`. A validation or domain error with nothing underneath omits `cause`.
- Keep fields safe and bounded: never store raw payloads, command arguments or output, signed URLs, or credentials. The exact value lives only in `cause`. Expose safe metadata such as a category, count, path, or host.
- Construct the error where the failure happens, and translate errors only at a transport. A translation passes domain errors through unchanged and wraps only unknown or lower-level failures.
- Use one encoding per distinction: a separate error class when callers or the user-facing message branch on it, and a field when it only helps diagnostics. When callers branch on the reasons a single operation can fail, use a tagged `reason` field instead and catch it with `Effect.catchReason` or `catchReasons`. Any error message that reaches the wire, the store, or the UI is behavior, so a refactor must preserve it.
- Do not write helpers whose whole body is `new SomeError(args)`. Write predicates as `export const isFoo = Schema.is(Foo)`.
- Catch one known tag (or a list sharing a handler) with `Effect.catchTag`, and several tags with distinct handlers using `Effect.catchTags({ ... })`. `Effect.catch` handles the whole error channel, and `catchIf` is for structural checks like a platform error code.
- Errors cross every wire as their tag and fields and decode back into the same class on the other side. The renderer branches on `_tag`, never on message text.

## 5. Lifetimes

- Acquire anything that must be undone with `Effect.acquireRelease` inside a `Scope`. Build any service that owns such a resource from a scoped effect, so shutting down the layer graph is the quit sequence. Do not add `stop()` methods, "stopping" flags, hand-ordered teardown, or exit backstop timers.
- A child process is an `effect/process` resource. It terminates when its scope closes, receiving SIGKILL 3 s after SIGTERM unless its command sets a grace period of its own (configured by `childDefaults` in [`engine/processes.ts`](packages/engine/src/processes.ts), which every graph that spawns processes provides). Wrap node-pty behind a small wrapper with the same shape. Keep the pid file for orphans, since a scope cannot help after a crash.
- Fork any fiber that must outlive the current effect into a scope (`Effect.forkScoped` or `Effect.forkIn`), never as a daemon. A background task with no interface is a `Layer.effectDiscard`, and resources built on demand per key are a `LayerMap.Service`.
- An operation that can be cancelled is interruptible by default. Any uninterruptible region must be explicit, short, and explain why.
- Each step of an operation that mutates state registers its undo as a finalizer, so a cancelled or failed operation unwinds itself.
- A multi-step state change must name its commit point (the single step after which it counts as done) and specify what a failure or interrupt at each step leaves behind: what is undone, and what is finished later on the next startup or by `sm doctor --fix`. Each operation uses the simplest strategy of completion, rollback (via the finalizers above), or recovery. There is no general transaction framework.

## 6. Concurrency

- Implement retries and backoff with a `Schedule` applied via `Effect.retry` or `Effect.repeat`. Do not use timer ladders or manual counters.
- Implement timeouts with `Effect.timeout` and its variants. Do not use `Promise.race` against a sleep.
- Every failed or parked state must define its way out. A transient failure (the network, a timeout, DNS, a deploy, configuration, or a child that won't start) either retries with capped backoff inside a scope or exposes a retry action the user sees and presses. Only a permanent fact about identity, version, deletion, or the user's intent parks for good: for example, a revoked or superseded device, or a build the hub turns away. System wake, the network coming back, and a session landing each notify the owner waiting on them.
- A deadline bounds a wait, not an outcome. An operation that commits elsewhere (a GitHub merge, a transfer, or an update) gets one shared elapsed budget across all its phases, measured in monotonic time or in polls, so a system sleep or a clock step spends none of it. Retry a failed poll within the budget. Once the budget expires, read the actual result before reporting anything (for example, a merge that landed while its poll timed out must be reported as merged). Nothing replays a create, merge, send, install, or delete to recover from a timeout.
- Represent a sequence of values over time as a `Stream`. A watcher is the `FileSystem` service's `watch` plus `Stream.debounce`, a fan-out is a `PubSub` read as a Stream, and a bounded buffer is a `Queue`. Backpressure comes from the consumer pulling, never from hand-counted credits.
- Use a `Semaphore` for mutual exclusion, `Effect.cached` or a `Cache` for a once-per-key computation, a `Ref` or `SubscriptionRef` for shared mutable state, and a `Deferred` when one fiber waits for another's result.
- For an answer cached temporarily in memory, use [`engine/keptAnswers.ts`](packages/engine/src/keptAnswers.ts), not a `Cache` TTL or `cachedWithTTL`: in this Effect version those APIs read the wall clock (which a sleep or a clock step moves) and cache failures unless told not to.

## 7. Platform access

- Access the filesystem, paths, processes, clock, randomness, and environment through services: `FileSystem`, `Path`, `effect/process`, `Clock`, `Random`, and `Config`. A service never imports `node:fs`, `node:child_process`, `node:os`, or `node:path`, and never reads `process.env`. Nothing in a service, `app/shared`, the host, the shell, the engine, the contracts, or the terminal `sm` may read `Date.now()` or `new Date()` (enforced by `no-wall-clock`). Non-Effect code in those areas takes `now` as a parameter and measures elapsed time with `performance.now()`.
- Every time decision must name its meaning, its owner, and its clock:
  - **Instants** (a date shown to a person, a persisted record, file metadata, an authority's token expiry, or a time compared with another device's) use `Clock.currentTimeMillis` or `DateTime.now`. Parse, format, and compute dates with `DateTime`, not `Date`.
  - **Elapsed time** (a deadline, a timeout, or a rate) uses `Clock.monotonicTimeNanos`, `Effect.timed`, or a relative timer (`Effect.sleep`, `Effect.timeout`), never the difference of two instants alone. Read a wall-clock gap only alongside a monotonic measurement, taking whichever is longer, so a system sleep that pauses the monotonic clock still counts (`ageOf` in [`engine/keptAnswers.ts`](packages/engine/src/keptAnswers.ts), a late turn in [`engine/liveness.ts`](packages/engine/src/liveness.ts)).
  - In this Effect version, `currentTimeMillis` and `currentTimeNanos` both read the wall clock (which a clock step moves), and so do Effect's RPC pinger, `Schedule`'s elapsed limits, and `Cache`'s TTLs. Never replace `Clock` wholesale with a monotonic clock, which would corrupt every instant.
- Every elapsed-time policy must state what a system sleep or a stopped process does to it: whether it counts time awake, counts time including the sleep, or is an absolute deadline. A Mac's monotonic clock pauses during sleep and keeps running while a process is stopped, so an observation spanning either event must be measured again afterward rather than trusted.
- Provide the platform layer once per process: `NodeServices` from `@effect/platform-node` in the host and the shells, and the Bun equivalent in the terminal binary. Write the engine against the service interfaces only and never against Bun globals. Each runtime wraps that layer with `canonicalPlatform` ([`packages/engine/src/canonicalPlatform.ts`](packages/engine/src/canonicalPlatform.ts)), so its `Path` and `FileSystem` return canonical paths. Paths stay canonical through storage and every wire, and only the UI displays them natively (the path model is documented at the top of [`packages/engine/src/canonicalPath.ts`](packages/engine/src/canonicalPath.ts)).
- Filesystem calls Node lacks (clones, swaps, file flags) go through the Go helper ([`nativefs/`](nativefs/)), behind one engine service with batched verbs. Do not add a native addon.
- `Logger` and `Tracer` replace `console.*`. Every service method uses `Effect.fn("Service.method")` so it has a span. Log at the point of decision, not at every step.

## 8. Contracts and wires

- Contracts are Schema. Every call is an `Rpc` definition in a per-module `RpcGroup`. Its payload, success, and error schemas are the single description of the call across every transport: the device socket, the loopback the shells use, and the terminal's control client.
- Per-call classification travels as annotations on the definition, read by middleware: `remote` (reaches a peer), `gated` (served to a peer only with the command switch on), `tracksProjectUsage`, `grant` (the consent text that covers the call), and `busy` (what a quit waits on the call for). Every host-scoped call must classify itself: `defineContract` throws as the module loads if an annotation is missing, and middleware also fails closed on a missing annotation.
- Subscriptions are streaming RPCs, with no broadcast channels. A client that needs a view subscribes once and stops polling for changes.
- Cancellation is RPC interruption. Do not build cancel registries or thread `AbortSignal`.
- A link on this machine has a lifecycle, not a heartbeat. The shell's ports to its windows and its host, as well as the loopback connections from a window, the shell, and the terminal `sm` to their own host, close when the port or process at either end exits or when the operation is cancelled. Neither end judges the other by pings, and the loopback listener never disconnects a link for silence. The shell's watchdog ([`main/core/host/watchdog.ts`](app/main/core/host/watchdog.ts)) is the single authority on whether the host still answers: it kills a silent host and starts another, and the links reconnect to the new one. A window's timer never decides on its own that its shell or its host is gone.
- When a server cannot parse a frame, log its size and the parse error, never its raw bytes, which can carry a token ([`shared/remote/rpcServer.ts`](app/shared/remote/rpcServer.ts)). Because a socket is read as a stream, a failed parser cannot locate the next frame, so the connection closes and its owner reconnects. A port preserves message boundaries, so it drops only the unreadable message (leaving its calls unanswered) and stays open.
- One owner retries a link, and one authority reports its liveness. A transport dials once (`quietProtocol` in [`engine/rpcClient.ts`](packages/engine/src/rpcClient.ts)), and any link that reconnects has one owner that does it: the direct keeper ([`shared/hub/directKeeper.ts`](app/shared/hub/directKeeper.ts)) for a peer link, Colibrii for the hub socket, and [`shared/remote/hostLink.ts`](app/shared/remote/hostLink.ts) for this machine's host link. A link tears down once and notifies its owner once.
- An overdue timer is never evidence that the other side had a chance to answer. Colibrii is the authority on liveness for links to another machine (a device link or the hub socket). When a one-shot request (`answerWithin` in [`engine/liveness.ts`](packages/engine/src/liveness.ts)) hits its deadline late by either clock (due to a hidden page's throttled timers, a sleep, or a stopped process), it asks again rather than giving up. Because Effect's RPC pinger judges a link by its last frame's age on the wall clock, `quietProtocol` gives it no timeout. Its pings only keep the far end's slot alive.
- An adapter preserves the transport's status and the peer's identity in what it raises, and a link logs its inbound and outbound lifecycle transitions.
- Bytes that a device on another build can read never change in place: changing them takes a version bump, of their module or of the core, along with a golden fixture ([`packages/contracts/README.md`](packages/contracts/README.md), "Wire samples").
- Reach the store only through the engine's services. No other package opens the database.

## 9. Tests

- Tests go through the service. Test layers replace only external dependencies (git, the hub, a peer, or the clock). Never mock the logic under test.
- Control time with `TestClock`. A test that needs a real sleep or a wall-clock timeout to pass is wrong. A proof gets a test clock from `testClock()` ([`app/test/lib/checkKit.mts`](app/test/lib/checkKit.mts)) and waits on a condition with `waitFor`, never on a fixed delay.
- Write tests as plain vitest cases that run their effects on the runtime of the thing under test: the engine sandbox's `box.engine(effect)` or the proofs' `runHost(effect)`. Effect's guidance uses `it.effect` from `@effect/vitest`, but the proofs already run on the host's and the engine's own runtimes and keep one consistent pattern. A test that spawns real git or the real `sm` keeps the forks pool, running each file in a process of its own. Files run one at a time only when they share something fixed, like a port.

## 10. Views and containers

The renderer's rule for views and containers lives in [`app/DESIGN.md`](app/DESIGN.md) ("Views and containers"). This section defines where a container's data comes from: ongoing state is a view, a refresh is a request, and an action is a request.

A host view (a streaming RPC) reaches a container as an atom on the client's runtime. Because it is live, nothing invalidates it. Its refresh is a request that reads the view now and resolves once that read has landed (`Views.refresh` in [`app/host/lib/Views.ts`](app/host/lib/Views.ts)), so a spinner bound to it stops on time. State kept from a push stream is an atom too.

A request (either a value computed when asked or an action) is a React Query query or mutation, and a push never feeds a reactivity key. A data family becomes a view once the host holds it as state and serves a view of it, while a one-off read stays a query. Requests do not go through `effect/reactivity`'s AtomRpc: its reactivity keys would be the push-to-key mapping ([`renderer/lib/hostWatch.ts`](app/renderer/lib/hostWatch.ts)) under another name, and what React Query gives a request (error toasts, focus refetch, staleness, and abort on unmount) would have to be rebuilt.

Each fact the renderer shows has one owner: a view or a request. A bridge that keeps two representations of one fact in agreement must explain why it stays.
