# Effect migration design

A plan for moving the Node side of Shigoto no Mori onto
[Effect](https://effect.website) v4. It is grounded in a survey of the
current code (September 2026, commit 85b218a2) and in the official
agent guide that ships inside the `effect` package
(`node_modules/effect/AGENTS.md`), which every phase below follows.

## 1. Recommendation in one page

**Adopt Effect v4 on the Node side, in five phases that each stand on
their own.** Effect goes where the app hand-rolls concurrency, lifecycle
and error plumbing today: `host/`, `main/core/`, `main/ipc/`,
`main/electron/`, and the browser-safe cores in `shared/hub`,
`shared/remote`, `shared/account`, `shared/ipc`. Each phase deletes a
named pile of hand-rolled code, has an exit criterion, and leaves the
app shippable, so the migration can pause after any of them.

**Keep Effect out of the renderer.** TanStack Query is the right tool for
what `renderer/` does, it is entrenched (53 `useQuery`, 52
`useMutation`), and React Compiler bails out of components on the
`try`/`finally` shapes that Effect interop needs. The renderer sees two
changes only: errors gain a `_tag` it can match on instead of message
text, and contract types come from Schema instead of zod.

**Do not replace the contract system with `effect/rpc` yet.** The
existing `defineContract` DSL carries product-specific axes (`remote`,
`mutating`, `movesHostState`, `tracksProjectUsage`) across five wires
and a credit-based byte-channel multiplexer, with golden tests pinning
the read surface. Handlers become Effects behind the same DSL. Swapping
the DSL for `RpcGroup` is a separate decision, deferred to the end.

**The tension to name.** PRODUCT.md ranks simplicity, YAGNI and
maintainability first, and says to cut abstraction beyond the smallest
correct thing. Effect is a large dependency and a programming model.
The survey shows why it still fits that rule: the codebase already
contains its own versions of Layer, Scope, Schedule, Semaphore, Queue,
PubSub, Stream, SubscriptionRef and TestClock, written many times over
(section 2). Replacing eight hand-rolled mechanisms with one library is
a reduction, not an addition, but only if every phase removes more code
than it adds. That is the rule each phase is held to, and the reason to
stop if a phase fails it.

Verified before writing this: Effect `4.0.0-rc.114` type-checks under
this repo's TypeScript 7.0.2 with the same `tsconfig` flags
(`verbatimModuleSyntax`, `erasableSyntaxOnly`, `strict`), including
`Context.Service`, `Schema.TaggedError`, `Effect.fn` with a semaphore,
`Schedule`, `SubscriptionRef` and `ChildProcessSpawner` from
`@effect/platform-node`. The spike is in Appendix A.

## 2. What the survey found

The numbers below are why the migration is worth doing and where it
should start. All paths are relative to the repo root.

### Errors are message strings

- 142 `throw new Error(...)` sites in `main/` and `host/`; 106 calls to
  `errorMessageOf`.
- Electron IPC keeps only the message, so `shared/errors.ts` recognizes
  errors by text: `isEntityGoneError` (`"Unknown project:"`),
  `isNoDirectConnectionError` (a prefix), `isBranchNotMergedError`
  (`"has unmerged commits"`). `isForwardConnectFailedError` does
  `startsWith("connect-failed")`. `usePortForwards.ts` searches messages
  for `EADDRINUSE` and `EACCES`. Git pins `LC_ALL=C` so callers can
  regex English stderr (`host/lib/git/branches.ts:135`,
  `host/lib/git/worktrees.ts:598`).
- The websocket `res` frame carries `message` plus an optional `code`,
  and the client re-types exactly one code (`command-refused`). The hub
  link sends message only and re-types one case by comparing text
  (`shared/hub/link.ts:694`).
- Typed error classes exist in a few places (`ControlError`,
  `HubRequestError`, `RemoteConnectError`, four hub link errors) and
  they are the places where control flow is clearest, for example
  `host/direct/cloudflared.ts:640-662` deciding retry versus park.
- The QueryClient retry predicate and toast suppression
  (`renderer/lib/queryClientOptions.ts:50-74`) depend on those text
  matchers.

### Cancellation exists on paper only

- Every handler receives `HandlerContext.signal`, minted per page
  generation, per socket connection and per control-wire connection.
  One consumer reads it (`host/socket/channelStreams.ts:118`). The
  control server says so itself: "the transfer orchestrators do not read
  it, so a transfer that started runs to its end"
  (`main/core/control/server.ts:9-11`).
- The renderer never passes an `AbortSignal` into an invoke.
- Git spawns have no timeout and no signal (`host/lib/git/core.ts:139`).
  A hung `git fetch` holds its `fetchInflight` entry forever and every
  later fetch of that project joins the hung promise.
- `Promise.race` timeouts leave the loser running: `endAllMirrorsBounded`
  (`main/ipc/handlers.ts:274`), `within()`
  (`host/ipc/modules/control.ts:102`), `waitWithTimeout`
  (`host/lib/scripts/index.ts:253`).
- What stands in for interruption is `stopped`/`running` latches with
  identity checks after each `await`: `cloudflared.ts:562-622`,
  `directKeeper.ts` `isCurrent`, `supervisor.ts` `if (!running)`, plus
  generation and epoch counters in the socket server, hub link and
  `ttlCache`.

### Lifecycle is hand-sequenced

- Composition happens at import time. `main/ipc/register.ts:138-258` and
  `main/ipc/handlers.ts:155-317` build the ws servers, tickets, tunnel
  runner, control server, direct plane, hub server, mirror gateway,
  daemon, history and git follower as module singletons with forward
  references between them.
- Fourteen `set*Impl` slots (`setCliRunnerImpl`, `setGitImpl`,
  `setMirrorImpl`, ...) throw if called before they are set, and
  `main/electron/hostImpls.ts` carries the note "Must run before
  registerIpcHandlers".
- Teardown is a hand-ordered sequence in `main/index.ts:550-628` with a
  15 s `app.exit(1)` backstop, and comments explaining the order
  ("forward teardown first, so its close frames ride the hub socket
  while it is still up").
- Known leak-prone spots: the untracked mirror-gateway retry timer
  (`main/ipc/handlers.ts:347`), the state-watcher debounce that fires
  after stop (`main/electron/stateWatcher.ts:38-51`), the background
  fetch and updater intervals with no stop path, listener sets with no
  unsubscribe (`onHostMutationSettled`, `registerInflightContributor`),
  and the idle registry as the only cleanup for transfer temp files.

### The same primitives are written many times

| Primitive | Hand-rolled copies |
|---|---|
| Semaphore / mutex | `createLimiter(n)` (`shared/util/limit.ts`) used as a 1-slot mutex in three lifecycles and as a 3/6/8 cap elsewhere; `withGlobalConfigWriteLock` promise chain; per-key `indexQueues`; `MAX_IN_FLIGHT_PER_PEER` counters |
| Backoff schedule | `BACKOFF_LADDER_MS` + `backoffDelayMs` (`shared/remote/supervisor.ts`), reused by the direct keeper, extended by `TUNNEL_BACKOFF_LADDER_MS` and `RESTART_LADDER_MS`; the updater's linear backoff; the cloudflared probe ladders with deadline and slow-down |
| Test clock | `SupervisorClock` interface and `fakeClock()` in `test/lib/checkKit.mjs:193-219` |
| Status ref with change stream | `let status` + `setStatus` + `onChange` in every factory (`cloudflared.ts:427`, `daemon.ts:92`, `supervisor.ts:176`) |
| PubSub | `peerPushListeners`, `mutationSettledListeners`, `configChangeListeners`, `createSubscriberRegistry`, `KeyedSubscribers` |
| Single-flight and cache | `fetchInflight`, `identityInFlight`, icon `inflight`, `ttlMapCache`/`ttlValueCache` with generations, `enrollInFlight` duplicated in `web/ipc/register.ts:243` and `main/ipc/modules/account.ts:71` |
| Queue with rerun | the do/while `pending` loops in `gitFollow.trigger`, `persistCache`, `updaterBridge.consume` |
| Stream | NDJSON line splitting for the CLI, PTY output batching (16 ms / 64 KiB), `fs.watch` then 300 ms debounce in three watchers, `coalesce()` leading-edge throttle |
| Scope | `makeTracker()` reverse-order teardown in tests, `teardownStep` fencing, the quit sequence |
| Layer | `create*({deps, clock?})` factories (the good half) and `set*Impl` slots plus import-time singletons (the other half) |

### What is already in good shape

The factories with injected dependencies map onto Layers almost
line for line: `createSupervisor`, `createCloudflaredRunner`,
`createMirrorDaemon`, `createControlServer`, `createDirectKeeper`,
`createHubConnectionCore`, `createDirectPlane`, `createWsServerBinding`,
`createIdleRegistry`, `createGitFollower`, `createPortForwardEngine`,
`createWebBridge`. Tests already drive them with fakes and never mock
modules. Input validation is unconditional at every wire
(`wrapContractCall`). These are the strengths the migration keeps.

## 3. Which Effect, and why

**Effect v4, release candidate, pinned exact.** As of this writing the
`rc` tag is `4.0.0-rc.117` and stable is targeted for Q3/Q4 2026. The
core team states no more broad breaking changes are planned. The
official `effect-ts` skill installs `effect@rc`. Reasons to skip v3:

- This app has no Effect code, so there is no v3 baggage to preserve,
  and starting on v3 buys a second migration within a year.
- v4 folds `@effect/platform` and `@effect/rpc` into the core package
  with a single version number, so the dependency list is two packages:
  `effect` and `@effect/platform-node`. Core has zero dependencies.
- v4's `Context.Service`, `Effect.fn`, `Schema.TaggedError` and the
  flattened `Cause` are the idioms the shipped agent guide teaches.

Two RC caveats to plan around:

1. **Import paths.** The published RC exposes unstable modules under
   `effect/unstable/<name>` (`process`, `socket`, `rpc`, `http`).
   The main branch has already moved them to `effect/<name>`. Stable
   will ship the short paths with no compatibility exports. Confine
   those imports to a handful of adapter files so the rename is one
   mechanical commit.
2. **Supply-chain cooldown.** The repo enforces a 7-day release age.
   Pin whichever RC is at least a week old at install time (`rc.114`,
   published 2026-09-11, qualifies today) and bump deliberately.

Packages:

| Package | Where | Why |
|---|---|---|
| `effect` | root, and `hub/` once the shared protocol schemas move (phase 4) | core: Effect, Layer, Schema, Schedule, Stream, Scope |
| `@effect/platform-node` | root | `NodeServices.layer` for `ChildProcessSpawner`, `FileSystem`, `Path`; `NodeSocket` if the ws adapter moves |
| `@effect/vitest` | not now | the repo has no root test framework; see section 4.9 |

## 4. Target architecture

### 4.1 Runtime and composition root

One `ManagedRuntime` per process, built from one application Layer.

```ts
// main/runtime.ts
export const runtime = ManagedRuntime.make(AppLive)
```

- `AppLive` is composed in `main/runtime.ts` from the runner services
  `main/ipc/register.ts` and `main/ipc/handlers.ts` declare and the
  Electron bindings in `main/electron/hostImpls.ts`, as five tiers
  joined with `Layer.provideMerge` (wires, remote plane, mirror
  gateway, engines, host impls). It replaces the import-time singleton
  graph and the `set*Impl` slots. A forward reference such as
  `directPlane` needing `hubServer` becomes an ordinary `Layer.provide`.
- Electron's `app.on("before-quit")` becomes `await runtime.dispose()`
  with the existing 15 s `app.exit(1)` backstop kept. Finalizers run in
  reverse acquisition order, which is the order the quit sequence
  documents by hand today. Steps that must survive a sibling's failure
  keep that property because a finalizer failure never skips the next
  one.
- Non-Effect edges (`ipcMain.handle`, `ws` callbacks, `fs.watch`
  callbacks, Electron events) go through `host/runtime.ts`: at install
  the slot captures the runtime's service context once and runs with
  `Effect.runPromiseWith(services)` / `runForkWith` / `runSyncWith`, so
  a handler or a stop that runs while the `ManagedRuntime` is being
  disposed still has its services (a `ManagedRuntime` refuses runs
  after `dispose()` begins). `hostHandler` is the phase 3 wrapper over
  that slot, under the caller's signal.
- The `host-boundary` test keeps its rules. Effect core is
  platform-neutral, so `shared/` may import `effect` but not
  `@effect/platform-node`; only `host/` and `main/` may.

### 4.2 Services and Layers

Follow the shipped guide: one `Context.Service` per capability, a
`static readonly layer` on the class, dependencies wired with
`Layer.provide`, identifiers of the form `"sm/<area>/<Name>"`.

```ts
export class Git extends Context.Service<Git, {
  run(cwd: string, args: ReadonlyArray<string>, opts?: RunOptions): Effect.Effect<string, GitError>
  runLenient(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitError>
  isRepo(cwd: string): Effect.Effect<boolean>
}>()("sm/host/Git") {
  static readonly layer = Layer.effect(Git, Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const selfWrite = yield* SelfWrite
    const run = Effect.fn("Git.run")(function* (cwd, args, opts) { /* ... */ })
    return Git.of({ run, runLenient, isRepo })
  })).pipe(Layer.provide(NodeServices.layer))
}
```

The `set*Impl` seams become services with two layers each: the real one
in `main/electron/`, and the layer tests already build by hand. The
`test/host-boundary.mjs` rule that `host/` never imports Electron stays
true because `host/` only declares the service; `main/` provides it.

Service inventory, grouped by the file that owns the logic today:

| Service | Today | Layer lives in |
|---|---|---|
| `Git` | `host/lib/git/core.ts` | host |
| `Gh` | `host/lib/githubCli/exec.ts` | host |
| `CliRunner` | `setCliRunnerImpl` + `main/electron/cliRunner.ts` | main (real), tests (fake) |
| `DataDir`, `RegistryStore`, `StateStore`, `GlobalConfig`, `ProjectConfig` | `host/lib/util/paths.ts`, `host/lib/config/*` | host |
| `ScriptRunner` | `host/lib/scripts/*` (node-pty stays) | host |
| `HubConnection` | `shared/hub/connection.ts` + `host/hub/connection.ts` | shared core, host and web adapters |
| `DirectPlane`, `DirectKeeper`, `DirectDialer` | `shared/hub/direct*.ts` | shared |
| `TunnelRunner` | `host/direct/cloudflared.ts` | host |
| `SocketHost` (LAN and direct listeners) | `host/socket/server.ts` | host |
| `ControlServer` | `main/core/control/server.ts` | main/core |
| `MirrorDaemon`, `MirrorGateway`, `MirrorHistory`, `GitFollower` | `main/core/mirror/*`, `host/mirror/*` | main/core, host |
| `PortForwardEngine` | `main/core/portForward/*` | main/core |
| `GitWatcher`, `StateWatcher` | `main/core/gitWatcher.ts`, `main/electron/stateWatcher.ts` | main |
| `BackgroundFetch`, `Updater` | `main/electron/fetch.ts`, `updater.ts` | main |
| `AccountService`, `AccountStore` | `shared/account/*` | shared core, main and web adapters |
| `Clock`-dependent things | `SupervisorClock` | Effect's built-in `Clock`; tests use `TestClock` |

### 4.3 Errors

Every error that crosses a function boundary is a `Schema.TaggedError`
declared next to the contract or service that raises it. Errors that
cross a wire are declared in `shared/` so both ends decode them.

```ts
// shared/errors/worktree.ts
export class UnknownWorktree extends Schema.TaggedError<UnknownWorktree>()("UnknownWorktree", {
  worktreeId: Schema.String,
}) {}
export class BranchNotMerged extends Schema.TaggedError<BranchNotMerged>()("BranchNotMerged", {
  branch: Schema.String,
}) {}
```

Rules:

- **The tag is the contract, not the message.** Renderer matchers
  (`isEntityGoneError` and friends) switch to `_tag`. Messages remain
  for display and are built from fields, so wording can change without
  breaking a matcher.
- **Classification lives on the error.** `RemoteConnectError.blocked`,
  `isTerminalDialError`, `CloseClassifier` verdicts and `ControlError.code`
  become fields or `reason` sub-tags, and retry policy uses
  `Schedule.while(({ input }) => input.retryable)` or `Effect.catchTag`.
- **Expected versus unexpected.** Anything the caller can act on is a
  typed failure. Bugs and impossible states are defects (`Effect.die`),
  which surface through the existing fatal-recovery path rather than
  as a toast.
- **Aggregation is `Cause`.** `Promise.allSettled` at quit and
  `chunkWindow`'s first-failure capture become `Effect.forEach` with
  `{ concurrency, mode: "either" }` or `Effect.all` with `mode:
  "validate"`, and failures are reported from the `Cause`.

### 4.4 Wires: how errors and cancellation travel

There are five wires. Each gets an additive change so mixed app versions
across a user's devices keep working, which is the existing version-skew
rule (new fields are optional, readers fall back to message text).

| Wire | Today | Change |
|---|---|---|
| Electron IPC (`main/preloadTransport.ts`) | rejection keeps message only | Handlers resolve an envelope `{ ok: true, value } \| { ok: false, error: EncodedTaggedError, message }`. The preload passes it through unchanged (contextBridge copies a thrown Error as message and stack only, so the preload cannot rebuild it) and the renderer builds `window.api` from the raw bridge and rebuilds the error on its side (`renderer/electronApi.ts`). Same process, both sides ship together, so no skew concern. |
| LAN and direct websocket (`shared/ipc/socket/frames.ts`) | `res { ok:false, message, code? }` | Add optional `error` (the encoded tagged error). Readers prefer `error`, fall back to `code`, then to `message`. |
| Hub broker (`shared/hub/link.ts`) | message only | Same `error` field on the broker's `res`. |
| Control wire (`main/core/control/server.ts`) | `code` for `ControlError` only | `ControlError` becomes a tagged error with `code` as a field; the `error` field is added; the Go CLI keeps reading `code`. |
| Go CLI NDJSON (`host/ipc/cliDelegate.ts`) | `{ ok:false, error, code }` documents | Unchanged. `cliDelegate` maps `code` to tagged errors, which it half does today (`unknown-project`, `unknown-worktree`). |

The `WireError` schema is a `Schema.Union` of every error declared in
`shared/errors/*`, plus a catch-all `UnknownWireError { message }` for
an error a newer peer sends that this build does not know.

Cancellation: `wrapContractCall` runs each handler with
`runtime.runPromise(effect, { signal: ctx.signal })`. Handler bodies
written as Effects are interruptible at every `yield*`, so a page
navigation, a dropped socket or a departed control client interrupts a
sync pull or a transplant poll where today it runs to the end.
Uninterruptible sections (a bundle already landing in
`refs/shigomori/`) are marked with `Effect.uninterruptible`, which is a
positive statement that is easy to audit.

### 4.5 Concurrency and lifecycle mapping

| Today | After | Notes |
|---|---|---|
| `createLimiter(1)` as lifecycle mutex | `Semaphore.make(1)` and `withPermits(1)` | `refresh`/`stop` serialization in the hub core, cloudflared, socket host |
| `createLimiter(3/6/8)` | `Effect.forEach(items, f, { concurrency: n })` | hygiene probes, worktree rows, dir walks |
| `withGlobalConfigWriteLock`, `indexQueues` | one `Semaphore` per config store; a `Semaphore` keyed by worktree via `RcMap` | |
| in-flight Maps (`fetchInflight`, icon `inflight`, `enrollInFlight`) | `Effect.cached` or a `Cache` with `capacity` and `timeToLive` | `Cache` also replaces `ttlMapCache`/`ttlValueCache` and their generation counters |
| do/while `pending` rerun loops | a `Queue.sliding(1)` drained by one forked fiber | `gitFollow.trigger`, `persistCache`, `updaterBridge.consume` |
| listener Sets | `PubSub` exposed as `Stream` | `peerPushListeners`, `mutationSettledListeners`, `configChangeListeners` |
| `status` + `setStatus` + `onChange` | `SubscriptionRef` with `SubscriptionRef.changes` | supervisor, tunnel, daemon, updater, socket host |
| `BACKOFF_LADDER_MS` + `backoffDelayMs` + stable reset | `Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("16 seconds")])`, wrapped in `Effect.retry`; the "stable for 30 s resets the ladder" rule is a `Schedule` reset on success | tunnel and daemon extend it with `Schedule.min` against a longer cap |
| `setTimeout` deadlines, `Promise.race`, `AbortSignal.timeout` | `Effect.timeout`, `Effect.race` | the loser is interrupted, which closes the leak class in section 2 |
| `fs.watch` + debounce timer | `Stream.callback` then `Stream.debounce("300 millis")`, forked in the layer scope | git watcher, state watcher, index-file watcher |
| PTY output 16 ms / 64 KiB batching | `Stream.groupedWithin(64 KiB worth of chunks, "16 millis")` | node-pty stays; only the batching moves |
| CLI NDJSON | `spawner.spawn` then `Stream.decodeText`, `Stream.splitLines`, `Stream.mapEffect(Schema.decodeUnknown(Doc))` | replaces `lineSplitter` and the `JSON.parse(line) as X` casts |
| child processes (`git`, `gh`, `cloudflared`, `file-sync`, `sm`) | `ChildProcessSpawner` from `effect/unstable/process`; `spawner.string`, `spawner.lines`, `spawner.spawn` with `Effect.scoped` | timeouts become `Effect.timeout`; the process is killed on interruption. Detached process-group kills (`killTrees`) stay as an explicit finalizer where the tree matters |
| the quit sequence | `runtime.dispose()` | order comes from Layer dependencies |
| `fakeClock()` | `TestClock` from `effect/testing` | `TestClock.adjust("16 seconds")` drives a `Schedule` deterministically |

### 4.6 Schema replaces zod

All validation moves to `effect/Schema`, which is the guide's rule
("all validation and domain modeling in Effect is done with Schema").
Roughly 400 zod schemas exist, 284 of them top-level in `shared/`.

- `InvokeDef` and `BroadcastDef` in `shared/ipc/contract.ts` take
  `Schema.Top` instead of `z.ZodTypeAny`. `shared/ipc/types.ts` maps
  `z.input`/`z.output` to `Schema.Encoded`/`Schema.Type`. Renderer
  hooks see the same TypeScript types as before.
- `wrapContractCall` uses `Schema.decodeUnknownSync(def.input)` for the
  unconditional input wall and `Schema.encodeSync(def.output)` for
  dev-build output checking, so behavior is unchanged.
- Current zod idioms have direct equivalents: `z.strictObject` is
  `strictStruct` (`shared/schemas/strict.ts`: v4 has no per-schema
  strictness, and `onExcessProperty: "error"` is only a decode-call
  option, so the helper refuses an undeclared key by name);
  `discriminatedUnion("t", ...)` is `Schema.Union` of `Schema.Struct`
  with `Schema.Literal` tags (or `Schema.TaggedStruct`); `.refine` is
  `Schema.check(Schema.filter(...))`; `.max()` bounds are
  `Schema.check(Schema.maxLength(n))`; the `SharedSettingsDocSchema`
  per-entry lenient transform is a `Schema.decodeTo` with a
  `SchemaGetter`.
- Ids get brands: `HexId32`, `DeviceId`, `WorktreeId`, `ProjectId`.
  Today none exist and every id is a plain `string`.
- `web/ipc/stubDefaults.ts` and `lab/bridge.ts` walk zod's runtime
  shape (`ZodObject`, `ZodEnum`, `ZodUnion`). They are rewritten against
  `SchemaAST`, which is a stable, documented tree rather than class
  instance checks.
- `hub/` compiles `shared/hub/protocol.ts`, so the Worker gains `effect`
  as a dependency for Schema alone. The core package tree-shakes to
  about 15 KB with Schema. The Worker's own routing stays plain; there
  is no requirement to write the Worker in Effect.
- `Schema.toStandardSchemaV1` exists if any third-party surface wants a
  Standard Schema object during the transition. None does today.

zod and Schema coexist during phase 4 only through a private
`Codec` interface in `contract.ts` (`decodeUnknown` and `encode`
functions) that both can satisfy. It is deleted with zod at the end of
the phase; it is not a permanent compatibility layer.

### 4.7 Observability

- `console.warn("[socket] ...")` and its 78 siblings become
  `Effect.logWarning` with `Effect.annotateLogs({ area: "socket" })`.
  The default logger prints the same bracketed line, so the log format
  the dev workflow reads does not change.
- Warn-once sets, transition-only logs and modulo throttles stay as
  small helpers; Effect has no built-in "log once per state entry".
- `Effect.fn("Git.run")` gives every service method a span. No exporter
  is wired in this migration. If one is ever wanted,
  `effect/unstable/observability` Otlp layers slot in without touching
  call sites. That is explicitly out of scope, per YAGNI.

### 4.8 The renderer and web bindings

- `renderer/` keeps TanStack Query, TanStack Router and its
  `useSyncExternalStore` stores. No `Effect` import in `renderer/`.
- `shared/errors.ts` matchers keep their names and switch to
  `error._tag === "UnknownWorktree"` with a message-text fallback that
  is removed once no supported peer version sends message-only errors.
- `web/ipc/register.ts` and `web/hub/connection.ts` consume the shared
  Effect cores (`HubConnection`, `DirectPlane`, `AccountService`) through
  a browser `ManagedRuntime`, mirroring what `main/` does. The
  duplicated `enrollInFlight`/`signOutInFlight` logic moves into the
  shared `AccountService` as `Effect.cached` and disappears from both
  bindings.
- `lab/bridge.ts` stays a fixture `window.api`; it only changes with the
  schema walk in 4.6.

### 4.9 Testing

The proof scripts in `test/` boot real components (real `ws` servers,
real git, the real CLI) and never mock modules. That style is kept:

- A proof that drives a Layer builds it with `Layer.provide` of test
  layers and runs with `Effect.runPromise`, from the same `.mjs` files.
- `fakeClock()` is replaced by `TestClock.layer()`, and
  `advance(ms)` by `TestClock.adjust(ms)`.
- New service-level checks are written as small Effect programs inside
  the existing proof files, using `Effect.runPromise` and
  `node:assert/strict`. `@effect/vitest` is not added, because the repo
  has no root test framework and `test/run.mjs` is the entry point
  lefthook uses. Revisit if the number of service unit tests makes a
  framework earn its keep.
- The existing invariants keep their tests: `host-boundary`,
  `socket-host` (remote and mutating tags, the read-surface golden),
  `hub-link`, `direct-plane`, `control`, `mirror`, `sync-transfer`.
  Each phase must leave them green.

## 5. Non-goals

- **Effect in React components or hooks.** Reasons in section 1.
  `@effect/atom-react` exists in v4 and would be the route if this
  changes, but it would be a second migration with its own design.
- **Rewriting the Go CLI or file-sync engine.** Untouched. Their wire
  documents are the contract.
- **Rewriting the hub Worker's routing in Effect.** It is 1.6k lines,
  tested inside workerd, and orchestration only. It takes `effect` for
  Schema in phase 4 and nothing else.
- **Replacing `defineContract` with `RpcGroup`.** Deferred; see phase 5.
- **Telemetry exporters, metrics.** Not built.
- **Replacing node-pty, `ws`, or the `Atomics.wait` cross-process lock.**
  They stay. Effect wraps them.

## 6. Phases

Each phase is one or a few PRs, has a deletion target, and ends with the
full check suite green (`pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
the lefthook proofs). The order is by value per line changed: errors
first because everything else builds on typed failures, lifecycle second
because it closes the leak list, handlers third, schemas fourth.

### Phase 0: Foundations (one PR, small)

Scope:

- Add `effect` and `@effect/platform-node` at an exact RC version that
  clears the release-age cooldown.
- Add the agent guidance the official `effect-ts` skill prescribes, in
  the project's agent instruction file. A repo-level `AGENTS.md` or
  `CLAUDE.md` does not exist yet, so create one with this section and
  nothing else the repo does not already say:

  ```md
  # Learning more about Effect

  This repository uses the Effect Typescript library.

  Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
  **completely**, and follow the links in the file when required.

  If you need to learn more about particular Effect apis and concepts that the
  guide doesn't cover, search through the source code in `node_modules/effect/src`.
  ```

- `main/runtime.ts` with `ManagedRuntime.make(Layer.empty)` and a
  `dispose` hooked into `before-quit`. Nothing uses it yet.
- `shared/effect/` conventions file: service id prefix `sm/`, layer
  naming (`layer`, `layerTest`), where errors live, and the `unstable`
  import rule (only in adapter files).
- Confirm `oxlint` and `oxfmt` accept generator-heavy code with no rule
  changes (the spike suggests they do; verify on the real tree).

Exit: type-check and all proofs green; bundle builds for main, preload
and web; app boots. Nothing else changes.

### Phase 1: Typed errors and wire encoding

Scope:

- `shared/errors/` gains the tagged error catalogue. First members, all
  of which have a text matcher or an `instanceof` site today:
  `UnknownProject`, `UnknownWorktree`, `BranchNotMerged`,
  `NoDirectConnection`, `CommandRefused`, `ForwardConnectFailed`,
  `ChannelOpenRefused { reason }`, `ControlError { code }`,
  `HubRequestError { status, code }`, `TunnelUnconfigured`,
  `TunnelProvisionDenied { status }`, `RemoteConnectError { code, blocked }`,
  `HubPeerOffline`, `HubMessageTooLarge`, `HubLinkDown`,
  `HubNoHandler { channel }`, `NoDialableCandidate`, `GitError { args,
  stderr }`, `GitOutputTruncated`, `CliFailed { code, message }`,
  `PortInUse { port }`, `PortDenied { port }`.
- `WireError` union and the additive `error` field on the socket,
  broker and control `res` frames; the envelope on the Electron wire.
- `errorMessageOf` stays. `errorCodeOf` becomes `errorTagOf`.
- Renderer matchers read `_tag` first, message second.
- `host/lib/git/core.ts` throws `GitError` with `stderr` as a field.
  The two stderr regex sites become `Effect.catchTag("GitError", ...)`
  with the same regex on the field, until phase 3 gives them a
  structured reason.

Deletes: message-text construction in `shared/errors.ts`, the
`noHandlerMessage` text comparison in `link.ts`, the `INVOKE_WRAPPER`
regex in `preloadTransport.ts`.

Exit: every `shared/errors.ts` matcher has a `_tag` path; `socket-host`,
`hub-link`, `control` proofs assert the `error` field round-trips;
`throw new Error` count in `main/`+`host/` drops by the number of
catalogued cases (target: under 100 from 142).

### Phase 2: Runtime, Layers, Scope, Schedule for the supervised runners

This is the highest-value phase. It targets the factories that already
inject their dependencies, converting each to a `Context.Service` with a
`layer`, in this order (each is its own PR):

1. `shared/remote/supervisor.ts` and `shared/hub/connection.ts` with
   `host/hub/connection.ts` and `web/hub/connection.ts`. The
   `SupervisorStatus` union stays as the value of a `SubscriptionRef`;
   the ladder becomes a `Schedule`; `refresh`/`stop` become
   `Semaphore.withPermits(1)`; `dial()`'s `settled`/`established`/
   `ownerClosed`/`dead` flags become one scoped `Deferred` plus
   interruption. `fakeClock` becomes `TestClock` in `hub-link` and
   `web-hub`.
2. `shared/hub/directKeeper.ts`, `directDial.ts`, `directPlane.ts`,
   `bridgeHandlers.ts`. Per-peer state becomes a `FiberMap` keyed by
   device id; "park on terminal error" is `Schedule.while` on the
   error; the candidate race is `Effect.raceAll` with the serialized
   hello as a `Semaphore`; the bridge's promise cache is a `Cache`.
3. `host/direct/cloudflared.ts`. Restart ladder, probe ladders,
   deadline and slow-down are Schedules; the pid-file orphan reaper is
   a finalizer; retry-versus-park is a `catchTag` table.
4. `main/core/mirror/daemon.ts`, `gateway.ts`, `history.ts`,
   `host/mirror/gitFollow.ts`. The untracked gateway retry timer becomes
   `Effect.retry` inside the layer scope, which closes leak 1.
5. `main/core/control/server.ts`, `host/socket/server.ts`, the port
   forward engine. Listeners are `Effect.acquireRelease`; per-connection
   state is a scope; the liveness sweep is a forked `Schedule.spaced`.
6. `main/core/gitWatcher.ts`, `main/electron/stateWatcher.ts`,
   `host/mirror/gitState.ts` index watcher, `main/electron/fetch.ts`,
   `main/electron/updater.ts`. Watchers are `Stream.callback` plus
   `Stream.debounce`; intervals are `Schedule.spaced` forked in scope.
   Closes leaks 2 and 3.
7. `main/ipc/register.ts` and `main/ipc/handlers.ts` compose `AppLive`
   from the above; `main/index.ts` boot becomes `runtime.runPromise` of
   a boot effect and quit becomes `runtime.dispose()`. `set*Impl` slots
   for these runners are deleted.

Deletes: `createLimiter` uses in lifecycles, `backoffDelayMs` and
every ladder constant, `SupervisorClock`, `fakeClock`, all
`stopped`/`running` latch checks in the converted files, the manual
quit sequence, the listener Sets those files own.

Exit: the leak list in section 2 is closed for items 1, 2, 3, 5 and 7;
`direct-plane`, `hub-link`, `web-hub`, `port-forward`, `control`,
`mirror` proofs pass with `TestClock`; a fresh count shows no
`setTimeout`/`setInterval` in the converted files except inside the
`Stream.callback` adapters.

### Phase 3: Handlers are Effects

Scope:

- `Handlers<M, Ctx>` in `shared/ipc/types.ts` accepts
  `Effect.Effect<Out, E, R>` as a handler return; `wrapContractCall`
  runs it with `runtime.runPromise(effect, { signal: ctx.signal })`,
  encodes a typed failure as `WireError`, and rethrows a defect. The
  Promise-returning form stays accepted during the phase so modules
  convert one at a time.
- `HandlerContext` capabilities (`notifier`, `isCallerCommandGranted`,
  `callerDeviceId`, `channels`) become services provided per call
  (`Effect.provideService`), so a handler that needs a caller identity
  declares it in `R` instead of checking `undefined` at runtime.
- Host services convert module by module. Suggested order by pain:
  `Git` (adds timeouts and interruption, closes leak 4), `CliRunner`
  (NDJSON as a Stream), `GlobalConfig`/`RegistryStore` (semaphores
  replace promise chains; registry reads gain a schema), `ScriptRunner`
  (batching as a Stream; `withDeleteInflight` as a scoped semaphore),
  then the orchestrations in `host/ipc/modules/sync.ts`, `mirror.ts`,
  `control.ts`, `worktrees.ts`, which is where ignored `ctx.signal`
  costs the most (leak 6). `oneShot.waitSettled` becomes
  `Effect.repeat` with a `Schedule` and `Effect.timeout`.
- `ttlMapCache`/`ttlValueCache` become `Cache`. In-flight Maps become
  `Effect.cached` or `Cache`.

Deletes: `createLimiter`, `coalesce`, `ttlCache`, `withGlobalConfigWriteLock`,
`indexQueues`, the in-flight Maps, `lineSplitter`, `waitWithTimeout`,
`within`, `endAllMirrorsBounded`, the remaining `set*Impl` slots.

Exit: `ctx.signal` is consumed by every handler (by construction);
`shared/util/limit.ts` and `host/lib/util/{coalesce,ttlCache}.ts` are
gone; `sync-transfer` and `control` proofs include an interruption
case (a caller departs mid-transfer and the temp file is gone
immediately, not after the 10 minute idle sweep).

### Phase 4: Schema replaces zod

Scope, in this order:

1. `contract.ts` takes `Schema.Top`; the private `Codec` shim admits
   zod for the duration.
2. `shared/schemas/*` port file by file, smallest first
   (`fs`, `shell`, `terrier`, `ports`, `runtime`, `launchers`,
   `scripts`, `hygiene`, `pullRequest`, `changes`, `project`, `worktree`,
   `config`, `sharedSettings`, `payloads`). Ids get brands as they go.
3. `shared/ipc/modules/*` and `shared/ipc/socket/frames.ts`,
   `shared/hub/protocol.ts`. `hub/package.json` gains `effect`.
4. `web/ipc/stubDefaults.ts` and `lab/bridge.ts` move to `SchemaAST`.
5. Persisted files (`registry.json`, `state.json`, `clientConfig.json`,
   `running-scripts.json`, `git-follow.json`, `mirror-history.json`)
   decode through Schema, including the ones read by cast today.
6. Remove zod from both `package.json` files and delete the shim.

Exit: `grep -r "from \"zod\""` is empty; `web-bridge`, `socket-host`
(read-surface golden unchanged), `shared-settings`, `hub` proofs pass;
the `SocketStatusMatchesSupervisor` type trick in `hub.ts` is replaced
by deriving the type from the schema.

### Phase 5: Decide, do not assume

Two candidates, each a separate decision made with phases 1 to 4 in
hand:

- **`effect/rpc` for the contract layer.** The mapping is clean on
  paper: each `InvokeDef` is an `Rpc.make` with `payload`, `success`,
  `error`; `remote`/`mutating`/`movesHostState`/`tracksProjectUsage` are
  Rpc annotations; the grant gate and usage tracking are
  `RpcMiddleware`; the Electron and hub-broker wires implement the
  `RpcServer.Protocol` and `RpcClient.Protocol` service interfaces
  (`run`, `send`, `end`, `disconnects`, `clientIds`); the LAN and
  direct listeners use `layerProtocolSocketServer`; byte channels stay
  a separate multiplexer as they are now. The cost is rewriting
  `buildClient`, `buildApi`, the frame schemas, the golden test and the
  lab bridge at once. Do it only if the phase 3 handler wrapper turns
  out to be re-implementing middleware.
- **`@effect/atom-react` in the renderer.** Only if TanStack Query is
  found to be the thing in the way, which nothing in the survey
  suggests.

**Decision (taken with phases 1 to 4 landed): neither.** The phase 3
wrapper did not re-implement middleware: `hostHandler` is a
`runPromise` under the caller's signal, and the grant gate, usage
tracking and host-state moves stayed where the contract axes already
put them (`wrapContractCall`, the broker, the socket host). Nothing
was written that `RpcMiddleware` would replace, so `effect/rpc` would
be a rewrite of five working wires and their golden proof for no
behavior. TanStack Query was never in the way in the renderer, and the
renderer stays Effect-free by design (section 4.8), so `@effect/atom-react`
is out. Both stay open as separate, later decisions if the wires or
the renderer's data layer are reworked for some other reason.

## Status (updated as phases land)

What is on the branch, in commit order, and what each step changed
about the plan above.

**Phase 0** landed: `effect` and `@effect/platform-node` at
`4.0.0-rc.114` (exact), `CLAUDE.md` with the official skill's rule to
read `node_modules/effect/AGENTS.md`, `main/runtime.ts` with an empty
`ManagedRuntime` the quit path disposes.

**Phase 1** landed. Every error a renderer or peer matches on is a
`Schema.TaggedError` with a tag constant beside its matcher in
`shared/errors.ts`; git raises `GitError`, `GitOutputTruncated` and
`GitSpawnError` from `host/lib/git/core.ts`; the CLI delegate raises
`CliFailed`; `ControlError` carries its code as a field. The wire
codec is `shared/ipc/wireError.ts`: an additive `error` field beside
`message` on the socket, hub and control frames, and an envelope on the
Electron wire. Two deviations from the plan:

- The preload cannot rebuild the error (contextBridge copies a thrown
  Error as message and stack only), so the renderer builds `window.api`
  from the preload's raw bridge and rebuilds it on its side
  (`renderer/electronApi.ts`), the way the web shell already installs
  its bridge. The raw bridge is gated to the contract channels.
- `shared/errors.ts` imports `effect`, so the renderer bundle carries
  Schema. The measured cost on the web build's main chunk was 0.13 kB.
  The Effect-free readers (`errorMessageOf`, `errorTagOf`) live in
  `shared/errorOf.ts` so a frame reader need not load Effect.

The in-process client errors (`RemoteConnectError`, the hub link
errors, `HubRequestError`) were left as plain classes: they never cross
a wire, and their modules are converted in Phase 2.

**Phase 2** landed in full. Steps 1 to 6: the reconnect supervisor,
the hub dial, the direct keeper, the cloudflared runner, the mirror
daemon, the git watcher, the state watcher, the control server, the
socket host and the port-forward engine (with its bridge) run as
Effect fibers under scopes; interruption is the cancel path; the clock
seams are gone and their proofs run under `TestClock`. Step 7: `AppLive`
lives in `main/runtime.ts` (section 4.1), every `set*Impl` slot is
gone, the runners are Layers (`SocketHost`, `DirectListener`,
`ControlServer`, `PeerPushes`, `MutationsSettled`, `HubConnection`,
`DirectPlane`, `TunnelRunner`, `DirectBroker`, `MirrorGateway`,
`MirrorDaemon`, `MirrorHistory`, `GitFollower`, `AccountHandlers`,
`PortForwardEngineLive`, `BackgroundFetchLive`, `UpdaterLive`,
`HostImplsLive`), and the normal quit awaits `runtime.dispose()` beside
the script reap inside the existing 15 s backstop; the install/relaunch
branch stops the control host, the mirror engine, the hub connection
and the direct host and disposes the runtime without waiting.
Deviations:

- The ladder is driven by an explicit loop with `Effect.sleep` and the
  shared `backoffDelayMs`, not by `Schedule.retry`: the `attempt` and
  `delayMs` the status reports, and the "stable resets the ladder, then
  waits one rung" rule, are exact contracts the proofs pin, and a
  `Schedule` reproduces them less directly than the loop does.
- Runners whose owners start and stop them synchronously from
  Promise-side code (the supervisor, the hub connection, the daemon)
  still fork with `runFork` behind a runtime seam that the Layer
  supplies; a throw from an owner callback inside a fiber is contained
  and logged, since a defect in a forked fiber is reported nowhere.
- `createLimiter` (`shared/util/limit.ts`) stays for the four
  call-ordered lifecycles (cloudflared reconciles, the socket host's
  accept path, the hub connection, the ws client transport). Effect's
  `Semaphore` wakes waiters in scheduler order, not arrival order, and
  the cloudflared proof caught the reconcile-order regression when it
  was swapped in.
- The status refs stayed as each runner's own `SubscriptionRef`-like
  pair where the runner has one subscriber; no shared status type was
  introduced beyond `SupervisorStatus`.

**Phase 3** landed. `host/lib/git/core.ts` exposes `runEffect` (every
git run has a timeout, 30 min by default, and is interruptible; a
write that must not stop halfway is marked `uninterruptible` at the
call site, in `sync.ts`, `changes.ts` and the sync, mirror and forward
handlers) and the git library exposes an `*Effect` form beside each
Promise form. Twenty of the twenty-five handler modules are
`hostHandler` Effects under the caller's signal, with `hostAttempt`
keeping each rejection the same error object the wire matched before
and `requireService` dying with the old "not installed" message; the
five that stayed plain (`direct`, `sharedSettings`, `globalConfig`,
`packageScripts`, `scripts`) delegate to services that are already
Effects or do only synchronous reads. The hand-rolled concurrency is
gone: per-worktree index locks are a call-ordered chain of turns per
path, the fetch, identity and icon single-flights are `Cache`s, the sync chunk
pump is a `Queue`, temp files are scoped, the PTY output batcher and
the CLI's NDJSON are `Stream`s, the fetch and updater loops are
`Schedule.spaced` fibers in their Layers, and the global config write
lock is a `Semaphore` with `PubSub` listeners. Deviations:

- `runGit` is `Effect.runPromise`, not the host runtime: the git
  effects need no service, and the proofs run them without a runtime.
- The `waitSettled` and the kill-escalation timings were kept to the
  millisecond (missing 10 s, connect 60 s, settle 30 min; SIGTERM grace
  then SIGKILL then a 5 s give-up), pinned by the new proofs.
- A mangled `registry.json` value (a `projects` entry that is not a
  list, say) now fails decoding with a named error where the old reader
  passed the garbage through. The ready handler's existing try/catch
  turns it into the boot error dialog, the same path a file that is not
  JSON already took; only a genuinely absent file reads as empty.

**Phase 4** landed. `zod` is gone from the app, the web shell, the lab
and the hub worker; `shared/ipc/codec.ts` is the one decode seam
(`decodeWith`, `safeDecodeWith`, `validateWith`, and `withoutProtoKeys`
stripping own `__proto__` keys before any decode), `shared/schemas/strict.ts`
gives the strict-object recipe (`strictStruct`, and the pick recipe
for subsets), and `test/schema-port.mjs` replays 249 recorded zod
accept/reject rows against the ported schemas. Deviations: the
`SocketStatusMatchesSupervisor` type trick in `hub.ts` stays, because
deriving the status from the supervisor's schema would pull the ws
client into the preload bundle; `Schema.TaggedError` puts `_tag` on the
instance (not the prototype), so every matcher reads a tag constant
and the lint config allows `_tag`.

**Phase 5** is decided: neither `effect/rpc` nor `@effect/atom-react`
(the reasoning is under Phase 5 above).

New proofs: `wire-error`, `supervisor`, `hub-dial`, `git-runner`,
`git-lib`, `ttl-cache`, `schema-port`, `config-store`, `scripts`,
`host-libs`, and `test/types/strict-struct.mts`; the `direct-plane`
keeper and cloudflared checks, the control server, the socket host and
the script runner's kill escalation run under `TestClock`. Each phase was reviewed
by a separate read-only reviewer against the previous behavior, and
the app was booted, driven over CDP and quit for real after phase 1,
after step 7 and after phase 3.

Measures at this point (the section 9 table's "now" column was taken
before the work began):

| Measure | Before | Now |
|---|---|---|
| `throw new Error(` in `main/` + `host/` | 142 | 89 |
| message-text error matchers with no tag path | 8 | 0 |
| child-process calls with no timeout | git: all | git: none |
| hand-rolled ladder and clock code | 5 files | 1 (the shared `backoffDelayMs`) |
| `set*Impl` slots | 14 | 0 |
| `fakeClock` proof harnesses | 12 sites | 0 |
| `zod` imports | every schema | 0 |
| proof scripts | 22 | 32 |

## 7. Conventions for the code that gets written

These mirror `node_modules/effect/AGENTS.md` and are what reviews hold
to:

- `Effect.gen` inline; `Effect.fn("Service.method")` for reusable
  functions on a service; `Effect.fnUntraced` in hot paths (frame
  decoding, PTY batching). No function that only wraps an `Effect.gen`.
- Extra behavior on an `Effect.fn` goes in its trailing arguments, not
  in a `.pipe` after it.
- Errors: `Schema.TaggedError`; `return yield* new X(...)` when raising.
  `Effect.catchTag`/`catchTags` to recover; `Effect.catch` only at a
  boundary that maps to a wire or a log.
- Services: `Context.Service<Self, Shape>()("sm/area/Name")`, a
  `static readonly layer`, `Self.of({...})`, dependencies via
  `Layer.provide`. Prefer `yield* Service` in a generator over
  `Service.use`.
- Resources: `Effect.acquireRelease` or `Effect.addFinalizer` inside
  the layer; background work is `Effect.forkScoped`; never a bare
  `setTimeout` outside a `Stream.callback` adapter.
- Time: `Effect.sleep`, `Schedule`, `Clock`, `DateTime`; never
  `Date.now()` or `setTimeout` in service code, so `TestClock` works.
- Predicates: the `Predicate` module, never a local `isRecord`.
- Validation: `Schema`, never a hand-written `typeof` walk.
- Interop: `runtime.runPromise(effect, { signal })` at every non-Effect
  edge, and nowhere else. No `Effect.runSync` in production paths
  except the preload's synchronous decode.
- `unstable` imports only in adapter files listed in
  `shared/effect/README.md`.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| RC churn before stable | Pin exact; bump on a schedule; the unstable-path rename is one commit confined to adapter files |
| The library's learning curve for a one-person project | The shipped `AGENTS.md` and `ai-docs` examples are the reference; phase 0 installs the rule that agents read them first; the conventions in section 7 are short enough to hold in the head |
| A phase adds more than it deletes | Each phase names its deletions and is measured (section 9); stop and reassess if a phase lands net-positive in lines |
| Version skew between a user's devices during phase 1 | Every wire change is an optional field with message fallback, the rule the codebase already follows |
| `shared/` bundle in the web client grows | Core is tree-shakeable; measure the web bundle in phase 2 step 1 and record the number |
| Electron main fiber runtime versus node-pty and `ws` callbacks | Both are plain Node; interop is `runFork` from their callbacks; the spike exercised `ChildProcessSpawner` under Node 22 |
| The synchronous `Atomics.wait` file lock and `execFileSync` keychain calls | Stay synchronous, wrapped in `Effect.sync`; they are short and documented |
| React Compiler | Not applicable while no Effect runs in the renderer |
| `oxlint`/`oxfmt` and TypeScript 7 | TS verified by the spike; lint and format are checked in phase 0 on the real tree |

## 9. How to know it is working

Counted at the end of each phase, from a clean checkout:

| Measure | Now | Target after phase 4 |
|---|---|---|
| `throw new Error(` in `main/` + `host/` | 142 | under 20 (defects only) |
| message-text error matchers | 8 | 0 |
| handlers that honor `ctx.signal` | 1 | all |
| child-process calls with no timeout | git: all | 0 |
| hand-rolled ladder and clock code | 5 files | 0 |
| `set*Impl` slots | 14 | 0 |
| listener Sets without unsubscribe | 2 | 0 |
| known leak spots (section 2) | 10 | 0 |
| zod schemas | about 400 | 0 |
| lines in `shared/util`, `host/lib/util/{coalesce,ttlCache,lockFile}` | present | only `lockFile` remains |
| net lines added by the migration | | negative |

## Appendix A: the spike

Type-checked with `typescript@7.0.2`, `effect@4.0.0-rc.114`,
`@effect/platform-node@4.0.0-rc.114`, `@types/node@24.13.3`, under the
repo's compiler flags. It shows the target shape for `Git`, a tagged
error, the backoff ladder as a `Schedule`, and a status ref.

```ts
import { Context, Effect, Layer, Schema, Schedule, Semaphore, SubscriptionRef, Stream, Duration } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodeServices } from "@effect/platform-node"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  args: Schema.Array(Schema.String),
  stderr: Schema.String,
}) {}
export class UnknownWorktree extends Schema.TaggedError<UnknownWorktree>()("UnknownWorktree", {
  worktreeId: Schema.String,
}) {}

export class Git extends Context.Service<Git, {
  run(cwd: string, args: ReadonlyArray<string>): Effect.Effect<string, GitError>
}>()("sm/host/Git") {
  static readonly layer = Layer.effect(Git, Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const probes = yield* Semaphore.make(6)
    const run = Effect.fn("Git.run")(function* (cwd: string, args: ReadonlyArray<string>) {
      const out = yield* spawner.string(ChildProcess.make("git", args, { cwd, env: { LC_ALL: "C" }, extendEnv: true })).pipe(
        Effect.mapError((cause) => new GitError({ args: [...args], stderr: String(cause) })),
        Effect.timeout("30 seconds"),
        Effect.catchTag("TimeoutError", () => new GitError({ args: [...args], stderr: "timed out" })),
      )
      return out
    }, probes.withPermits(1))
    return Git.of({ run })
  })).pipe(Layer.provide(NodeServices.layer))
}

type Phase = { phase: "idle" } | { phase: "connected"; peer: string } | { phase: "backoff"; attempt: number }
// 1s, 2s, 4s, 8s, 16s, 16s, ...: BACKOFF_LADDER_MS as a Schedule.
export const ladder = Schedule.min([
  Schedule.exponential("1 second", 2),
  Schedule.spaced("16 seconds"),
])
export const status = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Phase>({ phase: "idle" })
  const changes: Stream.Stream<Phase> = SubscriptionRef.changes(ref)
  yield* SubscriptionRef.set(ref, { phase: "backoff", attempt: 1 })
  return changes
})

export const program = Effect.gen(function* () {
  const git = yield* Git
  const head = yield* git.run(".", ["rev-parse", "HEAD"]).pipe(
    Effect.catchTag("GitError", (e) => Effect.succeed(`failed: ${e.stderr}`)),
  )
  yield* Effect.sleep(Duration.millis(1))
  return head
}).pipe(Effect.provide(Git.layer))
```

Two API names were guessed wrong on the first attempt and corrected
from the v4 source: there is no `Schedule.both`/`Schedule.andThen`
(use `Schedule.min`/`max`/`concat`), and `changes` is
`SubscriptionRef.changes(ref)`, not a property. This is the kind of
thing the phase 0 agent rule prevents: read `node_modules/effect/AGENTS.md`
and grep `node_modules/effect/src` instead of recalling v3 names.

## Appendix B: v4 names verified against the RC source

| Need | v4 API |
|---|---|
| service | `Context.Service<Self, Shape>()(id)`, `Self.of`, `Self.use` |
| service with defaults | `Context.Reference<T>(id, { defaultValue })` |
| layer from an effect, background task | `Layer.effect`, `Layer.effectDiscard`, `Layer.provide`, `Layer.provideMerge`, `Layer.launch` |
| runtime bridge | `ManagedRuntime.make(layer, { memoMap })`, `runtime.runPromise(effect, { signal })`, `runtime.dispose()` |
| errors | `Schema.TaggedError`, `Schema.Defect()`, `Effect.catchTag`, `Effect.catchTags`, `Effect.catch`, `Effect.catchCause`, `Effect.catchReason` |
| fork | `Effect.forkChild`, `Effect.forkDetach`, `Effect.forkScoped`, `Effect.forkIn`, `FiberMap`, `FiberSet`, `FiberHandle` |
| resources | `Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.scoped`, `Scope.provide` |
| time | `Effect.sleep`, `Effect.timeout`, `Effect.timeoutOption`, `Effect.race`, `Effect.raceAll`, `Clock`, `DateTime` |
| schedules | `Schedule.exponential`, `spaced`, `fixed`, `recurs`, `jittered`, `min`, `max`, `concat`, `while`, `tap`, `Effect.retry`, `Effect.repeat` |
| state | `Ref`, `SubscriptionRef.make`/`changes`, `SynchronizedRef`, `Deferred`, `Latch` |
| concurrency | `Semaphore.make(n).withPermits(k)`, `Queue.bounded`/`sliding`, `PubSub.bounded`, `Stream.fromPubSub`, `Effect.forEach(..., { concurrency })` |
| caching | `Effect.cached`, `Effect.cachedWithTTL`, `Cache.make`, `ScopedCache`, `RcMap`, `LayerMap` |
| streams | `Stream.callback`, `Stream.debounce`, `Stream.throttle`, `Stream.groupedWithin`, `Stream.decodeText`, `Stream.splitLines`, `Stream.runForEach` |
| processes | `ChildProcess.make`, `ChildProcessSpawner` (`string`, `lines`, `spawn`), `NodeServices.layer` |
| testing | `TestClock.layer()`, `TestClock.adjust`, `TestClock.setTime` from `effect/testing` |
| schema | `Schema.Struct`, `Union`, `Literal`, `TaggedStruct`, `Class`, `brand`, `check`, `decodeUnknownSync`, `encodeSync`, `toStandardSchemaV1`, `SchemaAST` |
| rpc (phase 5 only) | `effect/unstable/rpc`: `Rpc.make`, `RpcGroup.make`, `RpcMiddleware.Service`, `RpcServer.Protocol`, `RpcClient.Protocol`, `layerProtocolSocketServer` |

## Appendix C: sources

- Effect v4 RC announcement: https://effect.website/blog/releases/effect/40-rc
- Effect v4 RC August recap (migration skill, AI docs): https://effect.website/blog/effect-v4-rc-august-recap
- Official skills, `effect-ts` and `effect-v3-to-v4`: https://github.com/Effect-TS/skills
- Migration guides in the Effect repo: `MIGRATION.md` and `migration/*.md` at https://github.com/Effect-TS/effect
- The agent guide shipped in the package: `node_modules/effect/AGENTS.md` and `node_modules/effect/ai-docs/`
- Vendoring advice for agents: https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive
