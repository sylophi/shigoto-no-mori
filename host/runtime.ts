// The host's Effect runtime slot: the ONE seam through which the
// binding that owns the process (the Electron main process, the web
// bridge, a proof) hands the host its services. It replaces the
// set*Impl slots one by one (EFFECT-MIGRATION.md, Phase 2 step 7 and
// Phase 3): a host module declares a Context.Service, the binding
// provides its layer in the runtime it installs here, and a handler
// written as an Effect requires the service in its R.
//
// This file must stay Electron free (pnpm test host-boundary): it
// declares what the host needs, never how a binding provides it.
import { Effect, type ManagedRuntime } from "effect";
import { fromEffectWith } from "@shared/ipc/effectHandler";

// The union of every service a host handler may require. Empty until
// Phase 3 declares the first one; each conversion adds its tag here,
// so a binding that installs a runtime without it fails to type-check.
export type HostServices = never;

export type HostRuntime = Pick<
  ManagedRuntime.ManagedRuntime<HostServices, never>,
  "runPromise" | "runFork" | "runSync"
>;

// Effect's default services, for a proof that drives a host module
// with no binding, and for every handler until the first service.
const defaultRuntime: HostRuntime = {
  runPromise: Effect.runPromise,
  runFork: Effect.runFork,
  runSync: Effect.runSync,
};

let installed: HostRuntime | null = null;

// Called once at boot by the binding, before any handler runs. A
// second install is a composition bug and throws, like a second
// ipcMain.handle on a channel.
export function installHostRuntime(runtime: HostRuntime): void {
  if (installed !== null) {
    throw new Error("host runtime installed twice");
  }
  installed = runtime;
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
