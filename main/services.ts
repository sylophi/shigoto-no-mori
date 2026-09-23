// The desktop binding's view of the one runtime main/index.ts installs
// (main/runtime.ts builds it from AppLive): the host's services plus
// main's own, the runners and the Electron-side seams. The host reads
// the same runtime through host/runtime.ts; main reads it here, wider.
//
// A leaf on purpose: the service classes are only type-imported, so
// any module that declares or reads one can import this without an
// import cycle, and main/runtime.ts stays the one module that pulls
// every layer together.
import { type Context, Effect } from "effect";
import { errorMessageOf } from "@shared/errors";
import {
  hostRuntime,
  type HostServices,
  type RuntimeOf,
  serviceFrom,
} from "@host/runtime";
import type {
  AccountHandlers,
  GitFollower,
  MirrorDaemon,
  MirrorGateway,
  MirrorHistory,
} from "./ipc/handlers";
import type { Menu } from "./ipc/modules/menu";
import type { PortForwardEngine } from "./ipc/modules/portForward";
import type {
  ControlServer,
  DirectBroker,
  DirectListener,
  DirectPlane,
  HubConnection,
  MutationsSettled,
  PeerPushes,
  SocketHost,
  TunnelRunner,
} from "./ipc/register";

// What main provides beside the host's services.
export type MainServices =
  | Menu
  | PortForwardEngine
  | SocketHost
  | DirectListener
  | ControlServer
  | PeerPushes
  | MutationsSettled
  | HubConnection
  | DirectPlane
  | TunnelRunner
  | DirectBroker
  | MirrorGateway
  | MirrorDaemon
  | MirrorHistory
  | GitFollower
  | AccountHandlers;

export type AppServices = HostServices | MainServices;

// The installed runtime, typed with main's services. main/index.ts
// installs the runtime AppLive built (main/runtime.ts), so the host's
// slot holds one that provides them all.
export function appRuntime(): RuntimeOf<AppServices> {
  return hostRuntime() as unknown as RuntimeOf<AppServices>;
}

// One of the app's services off the installed runtime, memoized like
// the host's (host/runtime.ts serviceFrom says why). Absent, it throws
// `missing`, the message the module's setter slot threw before it was
// wired.
export function appService<I extends AppServices, S>(
  tag: Context.Key<I, S>,
  missing = `${tag.key} read before the app runtime was installed`,
): S {
  const found = serviceFrom(appRuntime(), tag);
  if (found === undefined) throw new Error(missing);
  return found;
}

// For a caller with a sensible answer when the runtime has none (a
// quit before the engine was ever wired has nothing to stop).
export function appServiceOrNull<I extends AppServices, S>(
  tag: Context.Key<I, S>,
): S | null {
  return serviceFrom(appRuntime(), tag) ?? null;
}

// A runner acquired by its factory and released by its stop, for a
// layer: the runtime's dispose runs the stops in reverse acquisition
// order. A stop that throws or rejects is logged and swallowed, so the
// next finalizer runs either way and one runner cannot fail the quit.
export const runner = <A>(
  what: string,
  create: () => A,
  stop: (created: A) => unknown,
) =>
  Effect.acquireRelease(Effect.sync(create), (created) =>
    Effect.tryPromise({
      try: async () => {
        await stop(created);
      },
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          console.warn(
            `[quit] ${what} failed to stop: ${errorMessageOf(error)}`,
          ),
        ),
      ),
    ),
  );
