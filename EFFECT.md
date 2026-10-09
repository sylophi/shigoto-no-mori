# Effect conventions

How Effect is written in this repo. Every TypeScript package follows
it: the engine, the host, the desktop and web shells, the contracts,
the hub, and the renderer's data layer. A review holds the lines a
PR changes to these rules, not older code.

Effect is pinned to one exact version, the latest stable release (the
workspace catalog). The source of that version, `node_modules/effect`
in any checkout, is the reference for any API question. `rpc`,
`socket`, `process`, `cli`, `http` and `sql` are marked
`@stability unstable` in that version. Never write a pattern on those
modules from memory; read the source first.

## 1. Where a capability lives

- A capability is a method on the service that owns its domain
  (`engine/worktrees`, `host/mirror`, ...). Extend the service that
  owns the domain; add a new one only when none does.
- Transports stay thin: an RPC handler, a terminal command, a shell
  bridge method, an MCP tool later. Each decodes its input, calls one
  service method, and maps the service's typed errors to the
  transport's. Filesystem, git, process or store work, multi-step
  dispatch, retries and rollback belong in the service.
- The reason is reach. The app, the terminal `sm`, a peer device and a
  test all reach the same method. Logic written into one handler is
  missing from the rest, and testing it needs a wire.
- Handlers add no spans or metrics of their own. Group middleware
  authorizes and instruments every call; per-call context is
  `Effect.annotateCurrentSpan`.
- Pure helpers (a slug, a label, layout math) are plain functions
  beside the service. The capability itself is the method.

## 2. The shape of a service module

One module per service, in this order: imports, errors and schemas,
the `Context.Service` tag with its interface inline, `make`, `layer`.

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

- **Imports are namespaces from subpaths:** `import * as Effect from
  "effect/Effect"`, never `import { Effect } from "effect"`. A service
  module is consumed the same way: `import * as Registry from
  "./Registry.ts"`, then `yield* Registry.Registry` and
  `Registry.layer`. Named imports are fine for a pure helper, an
  error, a schema or a type.
- **No standalone interface name.** The type is `Registry["Service"]`.
- **Dependencies come from the environment** (`yield*
  FileSystem.FileSystem`), never as parameters to `make`, never from a
  module global or a closure over a singleton. Configuration,
  immutable values and deliberate callbacks may be parameters; they
  are not services.
- **`make` is private** unless another module needs it. Use the
  constructor that fits: `Layer.succeed` or `Layer.sync` for a
  service with no effects, `Layer.effect` for one built with effects,
  a scoped constructor for one that owns a resource (section 5).
- **Tag names** are `sm/<package>/<Service>`.
- **Moving a service** updates every consumer. No re-export shims.

## 3. Runtime boundaries

- `ManagedRuntime.make`, `Effect.runPromise`, `runPromiseExit` and
  their kin belong only at the edges: React, Electron callbacks, the
  terminal entrypoint, a Promise-facing adapter during the migration.
  Never inside a service, a store module or a constructor.
- Each process composes one layer graph, per subsystem, in its own
  module: the engine's, the host's, the shell's, the terminal's. No
  module builds a runtime to hand out, and no feature gets a runtime
  of its own.
- During the migration a converted subsystem keeps its Promise
  interface for unconverted callers through one named adapter next to
  its layer. The adapter is deleted when the last caller moves.
  `PromiseAdapter.make` (`app/host/lib/util/promiseAdapter.ts`) builds
  it: a layer that goes into the graph beside the subsystem's, which
  captures the context when it is built and turns calls away once it
  is closed, and a `run` that the Promise functions callers already
  import go through. A call made before the graph is up waits for it.
  The proofs bring every adapter's layer up for each file
  (`app/test/lib/adapters.mts`). A subsystem that is one service
  takes `PromiseAdapter.forService`, whose `call` runs one of the
  service's methods.

  ```ts
  const promiseAdapter = PromiseAdapter.forService(Terrier, "terrier");
  export const adapter = promiseAdapter.layer;

  export const terrierReadiness = () =>
    promiseAdapter.call((terrier) => terrier.readiness);
  ```

## 4. Errors

- Failures are `Schema.TaggedError` classes with structured fields:
  the operation or stage, the path or id, a category. The message is
  fixed or built from those fields, never from `cause.message` or a
  stringified defect.
- A wrapped failure keeps the underlying error as `cause`. A
  validation or domain error with nothing underneath has none.
- Fields stay safe and bounded: no raw payloads, command arguments or
  output, signed URLs, credentials. The exact value lives only in
  `cause`. Expose a category, a count, a path, a host.
- Construct the error where the failure happens; translate only at a
  transport. A translation passes domain errors through and wraps only
  unknown or lower-level failures.
- One distinction, one encoding: a separate class when callers or the
  user-facing message branch on it, a field when it only helps
  diagnostics. A message that reaches the wire, the store or the UI is
  behavior, and a refactor keeps it.
- No helper whose whole body is `new SomeError(args)`. Predicates are
  `export const isFoo = Schema.is(Foo)`.
- Catch known tags with `Effect.catchTags({ ... })`, even for one
  tag. `Effect.catch` handles the whole channel; `catchIf` is for
  structural checks like a platform error code.
- Errors cross every wire as their tag and fields and decode back into
  the same class on the other side. The renderer branches on `_tag`,
  never on message text.

## 5. Lifetimes

- Anything that must be undone is acquired with
  `Effect.acquireRelease` inside a `Scope`. A service that owns such a
  resource is built from a scoped effect, and the layer graph's
  shutdown is the quit sequence. No `stop()` methods, no "stopping"
  flags, no hand-ordered teardown, no exit backstop timers.
- A child process is an `effect/process` resource; it ends when its
  scope closes. node-pty goes behind a small wrapper with the same
  shape. The pid file for orphans stays, since a scope cannot help
  after a crash.
- A fiber that must outlive the current effect is forked into a scope
  (`Effect.forkScoped`, `Effect.forkIn`), never as a daemon.
- An operation that can be cancelled is interruptible by default. An
  uninterruptible region is explicit, short, and says why.
- Each step of an operation that moves state registers its undo as a
  finalizer, so a cancelled or failed operation unwinds itself.

## 6. Concurrency

- Retries and backoff are a `Schedule` applied with `Effect.retry` or
  `Effect.repeat`. No timer ladders, no counters.
- Timeouts are `Effect.timeout` and its variants. No `Promise.race`
  against a sleep.
- A sequence of values over time is a `Stream`. A watcher is the
  `FileSystem` service's `watch` plus `Stream.debounce`; a fan-out is a
  `PubSub` read as a Stream; a bounded buffer is a `Queue`.
  Backpressure comes from the consumer pulling, never from
  hand-counted credits.
- Mutual exclusion is a `Semaphore`; a once-per-key computation is
  `Effect.cached` or a `Cache`; shared mutable state is a `Ref` or
  `SubscriptionRef`; one fiber waiting for another's result is a
  `Deferred`.

## 7. Platform access

- Filesystem, paths, processes, clock, randomness and environment are
  services: `FileSystem`, `Path`, `effect/process`, `Clock`, `Random`,
  `Config`. A service never imports `node:fs`, `node:child_process`,
  `node:os` or `node:path`, and never reads `process.env` or
  `Date.now()`.
- The platform layer is provided once per process: `NodeServices`
  from `@effect/platform-node` in the host and the shells, the Bun
  equivalent in the terminal binary. The engine is written against the
  service interfaces only and never against Bun globals.
- The darwin syscalls Node lacks go through the Go helper, behind
  one engine service with batched verbs. No native addon.
- `Logger` and `Tracer` replace `console.*`. Every service method is
  `Effect.fn("Service.method")` so it has a span. Log at the point of
  decision, not at every step.

## 8. Contracts and wires

- Contracts are Schema. Every call is an `Rpc` definition in a
  per-module `RpcGroup`; its payload, success and error schemas are
  the single description of the call for every transport: the device
  socket, the loopback the shells use, the terminal's control client,
  the hub.
- The per-call classification travels as annotations on the
  definition, read by middleware: `remote` (reaches a peer), `gated`
  (served to a peer only with the command switch on), `invitable` (the
  mirror invitation's exception, with its scope),
  `tracksProjectUsage`, and `grant` (the consent text that covers the
  call). A host-scoped call classifies itself; middleware fails closed
  on a missing annotation, and a proof checks every group.
- Subscriptions are streaming RPCs; there are no broadcast channels. A
  client that needs a view subscribes and stops asking what changed.
- Cancellation is RPC interruption. No cancel registries, no
  `AbortSignal` threading.
- Bytes that a device on another build can read do not change. A
  change to them is a protocol version bump with a golden fixture.
- The store is reached only through the engine's services. No other
  package opens the database.

## 9. Tests

- Tests go through the service. Test layers stand in only for
  external dependencies (git, the hub, a peer, the clock); the logic
  under test is never mocked.
- Time is `TestClock`. A test that needs a sleep or a wall-clock
  timeout to pass is wrong. Today's proofs wait with `waitFor` and
  `fakeClock`; each moves over as its subsystem converts.
- `@effect/vitest` provides `it.effect` and layer sharing. A proof that
  spawns real git or the real `sm` keeps the forks pool and no file
  parallelism.
- A boundary test (the differential clone test,
  the golden wire fixtures, the measurements) is a proof like any other
  and lives beside the code it guards.

## 10. Views and containers

The renderer's rule lives in `app/DESIGN.md` ("Views and containers").
In short: a view takes data and callbacks and only draws; a container
binds data to a view and has no markup of its own; nothing in the
renderer touches a global.

## Before you push

- Does any handler you touched do more than decode, call and map
  errors?
- Did you extend the domain's service before adding a new one?
- Does the error you added name its operation and resource, keep the
  cause, and leak no payload?
- Is every resource you opened released by a scope?
- Did knip pass? A new export with no importer fails it.
- Does every disabled diagnostic say why, in a comment above it?
