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
import type { RuntimeOf } from "@shared/remote/supervisor";
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

// The services the installed runtime provides, by who declares them.
// The host's are here. A binding whose runtime carries services of its
// own (main's runners) adds an entry by augmenting this interface
// (main/services.ts), so the one install demands them and hostService
// reads them typed.
export interface InstalledServices {
  host: HostServices;
}

export type InstalledService = InstalledServices[keyof InstalledServices];

// Effect's default services, for a proof that drives a host module
// with no binding. Every host service reads as absent on it, so a
// module reaching for one fails with its own "invoked before" message.
const defaultInstall = {
  runtime: {
    runPromise: Effect.runPromise,
    runFork: Effect.runFork,
  } as RuntimeOf<InstalledService>,
  services: Context.empty() as Context.Context<InstalledService>,
};

let installed: typeof defaultInstall | null = null;

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
  runtime: Pick<
    ManagedRuntime.ManagedRuntime<InstalledService, never>,
    "runSync"
  >,
): void {
  if (installed !== null) {
    throw new Error("host runtime installed twice");
  }
  const services = runtime.runSync(Effect.context<InstalledService>());
  installed = {
    runtime: {
      runPromise: Effect.runPromiseWith(services),
      runFork: Effect.runForkWith(services),
    },
    services,
  };
}

export function hostRuntime(): RuntimeOf<InstalledService> {
  return (installed ?? defaultInstall).runtime;
}

// For a proof's teardown, so the next check can install its own.
export function resetHostRuntime(): void {
  installed = null;
}

// A contract handler written as an Effect, adapted to the Promise the
// registrar (registerContract.ts) awaits from every handler. It runs
// with the caller's signal as the fiber's interruption, so a departed
// caller (a page that navigated, a peer whose socket dropped, a CLI
// that was killed) cancels the work at its next step instead of
// letting it run to the end. Its failures are the typed errors the
// wires carry (shared/errors.ts). A defect rejects like any thrown bug
// did. The runtime is read at call time, so a host handler's
// requirements are met by whatever the binding installed.
export function fromEffectWith<I, O, R, Ctx extends { signal: AbortSignal }>(
  runtime: () => Pick<RuntimeOf<R>, "runPromise">,
  handle: (input: I, ctx: Ctx) => Effect.Effect<O, unknown, R>,
): (input: I, ctx: Ctx) => Promise<O> {
  return (input, ctx) => {
    // A caller already gone starts nothing: runPromise would evaluate
    // the effect's first step before honoring the signal.
    if (ctx.signal.aborted) {
      return Promise.reject(new Error("the caller is gone"));
    }
    return runtime().runPromise(handle(input, ctx), { signal: ctx.signal });
  };
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

// One of the installed services, for a module whose body stays
// Promise-side (a delegate, a slot other modules call, a handler map
// too large to convert). Read off the services captured at install, so
// a read that lands while the runtime is disposing (a timer firing
// mid-quit) still finds it. Absent, it throws `missing`, the message
// the module's setter slot threw before it was wired.
export function hostService<I extends InstalledService, S>(
  tag: Context.Key<I, S>,
  missing = `${tag.key} read before the runtime provided it`,
): S {
  const found = hostServiceOrNull(tag);
  if (found === null) throw new Error(missing);
  return found;
}

// A service a module has a sensible answer without (nothing is
// mirroring on a surface that never mounts the daemon. A change nobody
// listens for goes unannounced).
export function hostServiceOrNull<I extends InstalledService, S>(
  tag: Context.Key<I, S>,
): S | null {
  return Option.getOrNull(
    Context.getOption((installed ?? defaultInstall).services, tag),
  );
}
