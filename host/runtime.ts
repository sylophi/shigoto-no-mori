// The host's Effect runtime slot: the ONE seam through which the
// binding that owns the process (the Electron main process, the web
// bridge, a proof) hands the host its services. It replaced the
// set*Impl slots (EFFECT-MIGRATION.md, Phase 2 step 7): a host module
// declares a Context.Service beside the shape it needs, the binding
// provides its layer in the runtime it installs here, and a handler
// written as an Effect requires the service in its R.
//
// This file must stay Electron free (pnpm test host-boundary): it
// declares what the host needs, never how a binding provides it.
import { Context, Effect, type ManagedRuntime, Option } from "effect";
import { fromEffectWith } from "@shared/ipc/effectHandler";
import type { CliRunner } from "@host/ipc/cliDelegate";
import type { PeerApis } from "@host/ipc/peerSync";
import type { CliTools } from "@host/ipc/modules/cli";
import type { ControlReach } from "@host/ipc/modules/control";
import type { BackgroundFetch } from "@host/ipc/modules/git";
import type { Launchers } from "@host/ipc/modules/launchers";
import type {
  MirrorGitChangedListener,
  MirrorServingListener,
} from "@host/ipc/modules/mirror";
import type { AppLifecycle } from "@host/ipc/modules/runtime";
import type { Updater } from "@host/ipc/modules/updater";
import type { FileSyncSpawn } from "@host/fileSync/spawn";
import type { MirrorEngine } from "@host/mirror/registry";

// The union of every service the host requires of its binding. A
// binding that installs a runtime without one of them fails to
// type-check.
export type HostServices =
  | CliRunner
  | PeerApis
  | CliTools
  | BackgroundFetch
  | Launchers
  | AppLifecycle
  | Updater
  | ControlReach
  | MirrorEngine
  | MirrorServingListener
  | MirrorGitChangedListener
  | FileSyncSpawn;

// What the host runs on: a ManagedRuntime, or anything shaped like
// one. `R` is what it provides, so a binding with services of its own
// on the same runtime (main's runners) reads them through a wider view.
export type RuntimeOf<R> = Pick<
  ManagedRuntime.ManagedRuntime<R, never>,
  "runPromise" | "runFork" | "runSync"
>;

export type HostRuntime = RuntimeOf<HostServices>;

// Effect's default services, for a proof that drives a host module
// with no binding. Every host service reads as absent on it, so a
// module reaching for one fails with its own "invoked before" message.
const defaultRuntime = {
  runPromise: Effect.runPromise,
  runFork: Effect.runFork,
  runSync: Effect.runSync,
} as HostRuntime;

let installed: HostRuntime | null = null;

// Called once at boot by the binding, before any handler runs. A
// second install is a composition bug and throws, like a second
// ipcMain.handle on a channel.
//
// What is kept is not the ManagedRuntime but the services it built,
// captured here (which builds its layers, synchronously, the moment
// the binding installs it): a ManagedRuntime refuses every run once
// its dispose() has begun, and the quit is long (a script reap, the
// runners' stops in order) while handlers, timers and the closing
// wires still call into the host. Running on the captured services
// keeps every read and every handler working through the quit, the
// way the setter slots kept their impls until the process exited,
// while the runtime's scope still owns the finalizers.
export function installHostRuntime(
  runtime: Pick<ManagedRuntime.ManagedRuntime<HostServices, never>, "runSync">,
): void {
  if (installed !== null) {
    throw new Error("host runtime installed twice");
  }
  const services = runtime.runSync(Effect.context<HostServices>());
  installed = {
    runPromise: Effect.runPromiseWith(services),
    runFork: Effect.runForkWith(services),
    runSync: Effect.runSyncWith(services),
  };
}

export function hostRuntime(): HostRuntime {
  return installed ?? defaultRuntime;
}

// For a proof's teardown, so the next check can install its own.
export function resetHostRuntime(): void {
  installed = null;
}

// A contract handler written as an Effect that may require the host's
// services, run on the installed runtime under the caller's signal.
export const hostHandler = <I, O, Ctx extends { signal: AbortSignal }>(
  handle: (input: I, ctx: Ctx) => Effect.Effect<O, unknown, HostServices>,
): ((input: I, ctx: Ctx) => Promise<O>) => fromEffectWith(hostRuntime, handle);

// A Promise-returning (or throwing) step inside a host handler. The
// rejection stays the handler's own failure, the very object thrown,
// so the wires carry it exactly as they carried a rejected Promise
// handler's (shared/ipc/wireError.ts). A multi-step body that must not
// stop halfway is ONE such step: a caller that leaves interrupts the
// wait, never the work.
export const hostAttempt = <A>(
  run: () => PromiseLike<A> | A,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: async () => run(), catch: (error) => error });

// A host service inside a handler written as an Effect: `yield*` of the
// tag, except that a runtime without it dies with `missing` (the
// message the module's setter slot threw before it was wired) rather
// than Effect's bare "Service not found".
export const requireService = <I, S>(
  tag: Context.Key<I, S>,
  missing: string,
): Effect.Effect<S, never, I> =>
  Effect.contextWith((context: Context.Context<I>) => {
    const found = Context.getOption(context, tag);
    return Option.isSome(found)
      ? Effect.succeed(found.value)
      : Effect.die(new Error(missing));
  });

// Any runtime can answer a lookup that requires nothing.
type Lookup = {
  runSync<A, E>(effect: Effect.Effect<A, E, never>): A;
};

const resolved = new WeakMap<Lookup, Map<string, unknown>>();

// One service off a runtime, or undefined when it does not provide it,
// for a module whose body stays Promise-side (a delegate, a slot other
// modules call, a handler map too large to convert). Memoized per
// runtime: every service here is a plain object the binding built
// once, and a read that lands while the runtime is disposing (a timer
// firing mid-quit) must still find it, the way a setter slot kept its
// impl until the process exited. Absence is not memoized.
export function serviceFrom<I, S>(
  runtime: Lookup,
  tag: Context.Key<I, S>,
): S | undefined {
  let memo = resolved.get(runtime);
  if (memo === undefined) {
    memo = new Map();
    resolved.set(runtime, memo);
  }
  if (memo.has(tag.key)) return memo.get(tag.key) as S;
  const found = runtime.runSync(Effect.serviceOption(tag));
  if (Option.isNone(found)) return undefined;
  memo.set(tag.key, found.value);
  return found.value;
}

// A host service off the installed runtime. Absent, it throws
// `missing`, the message the module's setter slot threw before it was
// wired.
export function hostService<I extends HostServices, S>(
  tag: Context.Key<I, S>,
  missing: string,
): S {
  const found = serviceFrom(hostRuntime(), tag);
  if (found === undefined) throw new Error(missing);
  return found;
}

// A host service a module has a sensible answer without (nothing is
// mirroring on a surface that never mounts the daemon; a change nobody
// listens for goes unannounced).
export function hostServiceOrNull<I extends HostServices, S>(
  tag: Context.Key<I, S>,
): S | null {
  return serviceFrom(hostRuntime(), tag) ?? null;
}
