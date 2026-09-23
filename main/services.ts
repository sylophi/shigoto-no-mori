// The services main provides beside the host's, on the one runtime
// main/index.ts installs (main/runtime.ts builds it from AppLive): the
// runners and the Electron-side seams. They join the host's install by
// augmenting host/runtime.ts's InstalledServices, so the install
// demands them and main reads them with the host's own hostService.
//
// A leaf on purpose: the service classes are only type-imported, so
// any module that declares or reads one can import this without an
// import cycle, and main/runtime.ts stays the one module that pulls
// every layer together.
import { Effect } from "effect";
import { errorMessageOf } from "@shared/errors";
import type { HostServices } from "@host/runtime";
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

declare module "@host/runtime" {
  interface InstalledServices {
    main: MainServices;
  }
}

// How long one runner's stop may take before the quit moves on
// without it: the stops run in tier order, so one that wedges (a
// child that ignores its kill, a socket close the peer never answers)
// would otherwise hold every later tier until the 15 s backstop
// exits the process with none of them run.
export const RUNNER_STOP_TIMEOUT_MS = 5_000;

// A runner acquired by its factory and released by its stop, for a
// layer: the runtime's dispose runs the stops in reverse acquisition
// order. A stop that throws, rejects or overruns its bound is logged
// and let go, so the next finalizer runs either way and one runner
// cannot fail the quit.
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
      Effect.timeoutOrElse({
        duration: RUNNER_STOP_TIMEOUT_MS,
        orElse: () =>
          Effect.sync(() =>
            console.warn(
              `[quit] ${what} did not stop within ${RUNNER_STOP_TIMEOUT_MS} ms, moving on (it keeps stopping in the background)`,
            ),
          ),
      }),
      Effect.catch((error) =>
        Effect.sync(() =>
          console.warn(
            `[quit] ${what} failed to stop: ${errorMessageOf(error)}`,
          ),
        ),
      ),
    ),
  );
