# Effect conventions

How Effect is written in this repo. Every TypeScript package follows
it: the engine, the host, the desktop and web shells, the contracts,
the hub, and the renderer's data layer. A review holds the lines a
PR changes to these rules, not older code. The shell's Electron-facing
modules (the menu, windows, deep links) are plain Electron code;
`app/main/README.md` says which of the shell is Effect.

Effect is pinned to one exact version, the latest stable release (the
workspace catalog), and a bump is a PR of its own. Effect itself is
never patched; a gap is wrapped on our side. Read Effect's own
guidance for that version before writing Effect code: `AGENTS.md` in
the installed package
(`node_modules/effect` in any package of the workspace, such as
`app/node_modules/effect/AGENTS.md`), the `ai-docs/` examples beside it
that it links, and for Schema, `SCHEMA.md` at the pinned tag
(`https://github.com/Effect-TS/effect/blob/effect@4.0.2/packages/effect/SCHEMA.md`,
a long guide to read in chunks; its tag moves with the catalog). This
file adds what the repo decides beyond it, and says why wherever it
departs from it. The source of that version, in the same folder, is
the reference for any API question. All of it is read only, and it
beats memory and any other copy of Effect's docs. `rpc`,
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
- A workflow over state only the host holds (scripts, terminals,
  mirrors) is owned by a host service, not pushed into the engine for
  uniformity.
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
  error, a schema or a type. Effect's guidance imports from `"effect"`;
  the repo keeps the one form `effect-namespace-imports` holds.
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
- **The layer is the module's export**, not a `static layer` on the
  tag as in Effect's guidance: a service spread over sub-makers needs
  `make` apart from the tag, and every service reads the same way.
- **Functions:** `Effect.gen` inline; a reusable function is
  `Effect.fn("name")` where a span helps (every service method) and
  `Effect.fnUntraced` otherwise (a helper, a hot path), and
  `Effect.fn.Return<A, E>` states a return type no tag gives.
  Combinators go to `Effect.fn` as its further arguments, not on a
  `.pipe`, and no function only wraps an `Effect.gen`. A failure is
  `return yield* new SomeError(...)`.
- **Configuration with a default** is a `Context.Reference`.
- **Data from outside** (a file, a wire, a process's output) is decoded
  with Schema, never `JSON.parse` and a cast or a hand-made guard. A
  runtime check on a value is `Predicate`, never a hand-written
  `isRecord` or `typeof x === "object" && x !== null`.
- **Tag names** are `sm/<package>/<Service>`.
- **Moving a service** updates every consumer. No re-export shims.
- **A service too big to hold at once spans a few modules**, one per
  area of what it does, in a folder named for it beside its module
  (`Worktrees.ts`, then `worktrees/listing.ts`, `worktrees/creating.ts`).
  Each area is a sub-maker: an `Effect.gen` that takes the services it
  needs from the environment, and as a parameter what an earlier area
  built for it, and returns that area's methods. The service's `make`
  runs the sub-makers in dependency order and composes `Service.of`
  from what they return. The tag, `make` and `layer` stay in the
  service module. The errors, documents and helpers the areas share go
  in the folder too (`worktrees/documents.ts`), so no area imports the
  service module back; the service module re-exports what consumers
  use, so it stays the one place they import. A sub-maker has no tag
  and no layer, and nothing outside the service imports it.

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

- `ManagedRuntime.make`, `Effect.runPromise`, `runPromiseExit` and
  their kin belong only at the edges: React, Electron callbacks, the
  terminal entrypoint, a proof. Never inside a service, a store module
  or a constructor.
- Each process composes one layer graph, per subsystem, in its own
  module: the engine's, the host's, the shell's, the terminal's. No
  module builds a runtime to hand out, and no feature gets a runtime
  of its own.
- A renderer client (a desktop window, a web client tab, the lab's
  fake host) is one `ManagedRuntime` over its links
  (`app/renderer/lib/runtime`), built as the page boots and disposed
  as it goes. Its calls, views and pushes run on it, so a view's fiber
  is interrupted when its subscriber stops, and nothing outlives the
  page.
- A host handler answers with an effect on the services of the host's
  graph (`app/host/process/services.ts`), run where the call is served
  (`registerHostContract`), and a view reads with one (`Views.view`).
  Its handler table `satisfies` the contract's `Handlers`, so each
  method keeps its own type for a caller in the host.
- The host's composition root reaches its graph from the callbacks it
  hands code that is not Effect (the hub connection, the account
  fan-out, the store changes) through one door,
  `app/host/process/graph.ts`: a layer on top of the graph, so a run
  made before every service is up waits for it, and one made after the
  graph closed is turned away. Nothing outside `app/host/process/`
  uses it. The proofs bring the host's services up for each file
  (`app/test/lib/hostRuntime.mts`) and run on them with `runHost`.

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
  diagnostics. The reasons one operation fails for, when callers
  branch on them, can be a tagged `reason` field instead, caught with
  `Effect.catchReason` or `catchReasons`. A message that reaches the
  wire, the store or the UI is behavior, and a refactor keeps it.
- No helper whose whole body is `new SomeError(args)`. Predicates are
  `export const isFoo = Schema.is(Foo)`.
- Catch one known tag (or a list sharing a handler) with
  `Effect.catchTag`, several with `Effect.catchTags({ ... })`.
  `Effect.catch` handles the whole channel; `catchIf` is for
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
  scope closes, with SIGKILL 3 s after its SIGTERM unless its command
  sets a grace of its own (`childDefaults` in `engine/processes.ts`,
  which every graph that spawns provides). node-pty goes behind a
  small wrapper with the same shape. The pid file for orphans stays,
  since a scope cannot help after a crash.
- A fiber that must outlive the current effect is forked into a scope
  (`Effect.forkScoped`, `Effect.forkIn`), never as a daemon. A
  background task with no interface is a `Layer.effectDiscard`, and
  resources built on demand per key are a `LayerMap.Service`.
- An operation that can be cancelled is interruptible by default. An
  uninterruptible region is explicit, short, and says why.
- Each step of an operation that moves state registers its undo as a
  finalizer, so a cancelled or failed operation unwinds itself.
- A change of state in several steps names its commit point, the one
  step after which it counts as done, and what a failure or an
  interrupt at each step leaves: what is undone, and what is finished
  after it, at the next start or by `sm doctor --fix`. Each operation
  takes the simplest of completion, rollback or recovery; there is no
  general transaction framework.

## 6. Concurrency

- Retries and backoff are a `Schedule` applied with `Effect.retry` or
  `Effect.repeat`. No timer ladders, no counters.
- Timeouts are `Effect.timeout` and its variants. No `Promise.race`
  against a sleep.
- **A path back from every failure.** Every failed or parked state
  names its way out. A transient failure (the network, a timeout, DNS,
  a deploy, configuration, a child that won't start) gets a retry with
  a cap, owned by a scope, or a retry the user sees and presses. Only a
  fact about identity, version, deletion or the user's intent parks for
  good: a revoked or superseded device, a build the hub turns away. A
  wake, the network coming back and a session landing each reach the
  owner that waits on them.
- **A deadline bounds a wait, not an outcome.** An operation that
  commits elsewhere (a GitHub merge, a transfer, an update) has one
  elapsed budget through all its phases, in monotonic time or in
  polls, so a sleep or a clock step spends none of it. A poll that
  fails is asked again within the budget, and past it the real result
  is read before anything is reported: a merge that landed while its
  poll timed out reads as merged. Nothing replays a create, merge,
  send, install or delete to cure a timeout.
- A sequence of values over time is a `Stream`. A watcher is the
  `FileSystem` service's `watch` plus `Stream.debounce`; a fan-out is a
  `PubSub` read as a Stream; a bounded buffer is a `Queue`.
  Backpressure comes from the consumer pulling, never from
  hand-counted credits.
- Mutual exclusion is a `Semaphore`; a once-per-key computation is
  `Effect.cached` or a `Cache`; shared mutable state is a `Ref` or
  `SubscriptionRef`; one fiber waiting for another's result is a
  `Deferred`.
- An answer kept for a time in the host's memory is
  `app/host/lib/util/kept.ts`'s, not a `Cache` TTL or `cachedWithTTL`:
  in this version those read the wall clock, which a sleep or a clock
  step moves, and keep a failure unless told not to.

## 7. Platform access

- Filesystem, paths, processes, clock, randomness and environment are
  services: `FileSystem`, `Path`, `effect/process`, `Clock`, `Random`,
  `Config`. A service never imports `node:fs`, `node:child_process`,
  `node:os` or `node:path`, and never reads `process.env`. Nothing in
  a service, `app/shared`, the host, the shell, the engine or the
  contracts reads `Date.now()` or `new Date()` (`no-wall-clock`); code
  there that is not Effect takes `now` as a parameter, as
  `host/direct/tickets.ts` does, and measures with `performance.now()`.
- **Time.** Every time decision names its meaning, its owner and its
  clock. An instant (a date shown to a person, a persisted record, file
  metadata, an authority's token expiry, a time compared with another
  device's) is `Clock.currentTimeMillis` or `DateTime.now`, and dates
  are parsed, formatted and computed with `DateTime`, not `Date`.
  Elapsed time (a deadline, a timeout, a rate) is
  `Clock.monotonicTimeNanos`, `Effect.timed` or a relative timer
  (`Effect.sleep`, `Effect.timeout`), never the difference of two
  instants. In this version `currentTimeMillis` and `currentTimeNanos`
  are both the wall clock, which a clock step moves, and so is what
  Effect's RPC pinger, `Schedule`'s elapsed limits and `Cache`'s TTLs
  read. The `Clock` is never replaced wholesale with a monotonic one,
  which would corrupt every instant.
- Every elapsed policy says what a sleep or a stopped process does to
  it: it counts time awake, or time including the sleep, or it is an
  absolute deadline. A Mac's monotonic clock stands still in a sleep
  and runs on while a process is stopped, so an observation that spans
  either is measured again after it, not trusted.
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
  the hub's relay. The hub's own routes are an `HttpApi`
  (`packages/contracts/src/hubApi.ts`), each endpoint's schemas the
  one description of that route for the Worker and the app alike.
- The per-call classification travels as annotations on the
  definition, read by middleware: `remote` (reaches a peer), `gated`
  (served to a peer only with the command switch on), `invitable` (the
  mirror invitation's exception, with its scope),
  `tracksProjectUsage`, `grant` (the consent text that covers the
  call), and `busy` (what a quit waits on the call for). A host-scoped
  call classifies itself; middleware fails closed
  on a missing annotation, and a proof checks every group.
- Subscriptions are streaming RPCs; there are no broadcast channels. A
  client that needs a view subscribes and stops asking what changed.
- Cancellation is RPC interruption. No cancel registries, no
  `AbortSignal` threading.
- **A link on this machine has a lifecycle, not a heartbeat.** The
  shell's ports to its windows and its host, and the loopback dials of
  a window, the shell and the terminal `sm` to their own host, close
  when the port or the process at either end goes, or the operation is
  cancelled. No end judges the other by pings, and the loopback
  listener cuts none of them for silence. The shell's watchdog
  (`main/core/host/watchdog.ts`) is the one judge of whether the host
  still answers: it kills a silent host and starts another, and the
  links dial that one. A window's timer never decides on its own that
  its shell or its host is gone.
- **A frame a server can't read** is logged with its size and the
  parse error, never its bytes, which can carry a token
  (`shared/remote/rpcServer.ts`). A socket is read as a stream, and a
  parser that failed can't find the next frame, so the connection
  closes and its owner dials again. A port keeps its messages whole,
  so the one message is dropped, its calls unanswered, and the port
  stays up (`pnpm test shell-link`).
- **One owner retries a link, and one authority reports its
  liveness.** A transport dials once (`quietProtocol` in
  `engine/rpcClient.ts`), under an owner that dials again (the direct
  keeper, `hostLink`). The host's cut of a silent
  peer frees its slot; it isn't a second verdict on the peer. A link
  is torn down once and tells its owner once.
- **No overdue timer is evidence** that the other side had a chance
  to answer. A link to another machine (a device's, the hub socket)
  is judged only on a fresh probe that was out for its whole window
  while this end ran (`engine/liveness.ts`): a probe past its timeout
  is the cue for a fresh one, a turn that comes late by either clock
  (a hidden page's throttled timers, a sleep, a stopped process) asks
  again, and any frame after the probe answers it. A question asked
  once follows the same rule (`answerWithin`): one whose limit came
  late asks again rather than give up. The host's cut of a silent
  remote peer counts silence in monotonic time
  (`host/socket/DeviceLink.ts`). Effect's RPC pinger judges a link by
  its last frame's age on the wall clock, so it judges nothing here;
  its pings only keep the far end's slot.
- An adapter keeps the transport's status and the peer's identity in
  what it raises, and a link logs its lifecycle transitions, inbound
  and outbound.
- Bytes that a device on another build can read do not change. A
  change to them is a protocol version bump with a golden fixture.
- The store is reached only through the engine's services. No other
  package opens the database.

## 9. Tests

- Tests go through the service. Test layers stand in only for
  external dependencies (git, the hub, a peer, the clock); the logic
  under test is never mocked.
- Time is `TestClock`. A test that needs a sleep or a wall-clock
  timeout to pass is wrong. A proof gets one from `testClock()`
  (`app/test/lib/checkKit.mts`) and waits on a condition with
  `waitFor`, never on a fixed delay.
- Tests are plain vitest cases that run their effects on the runtime
  of the thing under test: the engine sandbox's `box.engine(effect)`,
  the proofs' `runHost(effect)`. Effect's guidance uses `it.effect`
  from `@effect/vitest`; the proofs already run on the host's and the
  engine's own runtimes, and keep one way to. A proof that spawns real git or the
  real `sm` keeps the forks pool and no file parallelism.
- A boundary test (the differential clone test,
  the golden wire fixtures, the measurements) is a proof like any other
  and lives beside the code it guards.
- A workflow that changes state is proved by a failure injected
  between each pair of its external steps and by a recovery that
  itself fails, and its cleanup is proved after a refusal and after a
  kill, not only after success.
- A proof of a time decision moves the clocks apart, as a machine
  does: a sleep (the wall clock runs on while monotonic time and every
  timer stand still) and a stopped process (both clocks run on and no
  timer runs), each carried past the timeouts in play, and the epoch
  stepped forward and back with monotonic time still (`sleepingClock`
  in `app/test/lib/checkKit.mts`, `pnpm test clock-steps`). A
  `TestClock` jump alone is not a sleeping laptop. The proof checks
  that the user sees the thing recover and that no committed action
  ran twice.
- A burst of pushes is proved by a bounded call count and no
  cancellations.

## 10. Views and containers

The renderer's rule lives in `app/DESIGN.md` ("Views and containers").
In short: a view takes data and callbacks and only draws; a container
binds data to a view and has no markup of its own; nothing in the
renderer touches a global. Ongoing state is a view, a refresh is a
request, and an action is a request. A host view (a streaming RPC)
reaches a container as an atom on the client's runtime; its refresh
is a call that reads the view now and answers once that read landed
(`Views.refresh` in `app/host/lib/Views.ts`), so a spinner bound to it
ends on time. A request (a value computed when asked, or an action) is
a React Query query or mutation; a push never feeds a reactivity key.
Requests don't go through `effect/reactivity`'s AtomRpc: it keeps the
push-to-key mapping under another name and rebuilds what React Query
gives a request (its error toasts, focus refetch, staleness, abort on
unmount).

Each fact the renderer shows has one owner, a view or a request. A
bridge that keeps two representations of one fact in agreement says
why it stays.

## Before you push

- Does any handler you touched do more than decode, call and map
  errors?
- Did you extend the domain's service before adding a new one?
- Does the error you added name its operation and resource, keep the
  cause, and leak no payload?
- Is every resource you opened released by a scope?
- Did knip pass? A new export with no importer fails it.
- Does every disabled diagnostic say why, in a comment above it?
