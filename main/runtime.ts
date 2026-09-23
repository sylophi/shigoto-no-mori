// The desktop process's one Effect runtime. Every service the host and
// the Electron binding provide is composed into AppLive here, and the
// non-Effect edges (ipcMain handlers, ws callbacks, Electron events)
// run their work through `runtime`, which main/index.ts installs as the
// host's runtime (host/runtime.ts) before any handler is registered.
// Disposing it on quit runs every layer's finalizers in reverse
// acquisition order, which is the teardown ordering main/index.ts used
// to sequence by hand: a layer is released before anything it depends
// on, and siblings in one tier are released together.
import { Layer, ManagedRuntime } from "effect";
import { HostImplsLive } from "./electron/hostImpls";
import {
  AccountHandlers,
  MirrorEngineLive,
  MirrorGateway,
  PortForwardEngineLive,
} from "./ipc/handlers";
import {
  ControlServer,
  DirectListener,
  MutationsSettled,
  PeerPushes,
  RemotePlaneLive,
  SocketHost,
} from "./ipc/register";
import type { AppServices } from "./services";

// Shared across every ManagedRuntime this process builds so a layer is
// memoized once even when a second runtime provides it.
export const appMemoMap = Layer.makeMemoMapUnsafe();

// The layer graph, bottom up. Each tier is provided to everything
// above it, so it is acquired first and released last:
//
//   HostImplsLive          the host's services, over the runners below
//   PortForwardEngine, the mirror daemon/follower/history,
//   ControlServer, AccountHandlers
//   MirrorGateway          binds (and retries) inside its scope
//   RemotePlane            tunnel, hub connection, direct plane, broker
//   SocketHost, DirectListener, PeerPushes, MutationsSettled
//
// So on quit the forwards stop while the direct sessions and the hub
// socket they ride are still up, the control listener unpublishes
// before the remote plane goes, the mirror engine stops before the
// gateway it dials through, and the listeners close last.
const WiresLive = Layer.mergeAll(
  SocketHost.layer,
  DirectListener.layer,
  PeerPushes.layer,
  MutationsSettled.layer,
);

const EnginesLive = Layer.mergeAll(
  PortForwardEngineLive,
  MirrorEngineLive,
  ControlServer.layer,
  AccountHandlers.layer,
);

export const AppLive: Layer.Layer<AppServices> = HostImplsLive.pipe(
  Layer.provideMerge(EnginesLive),
  Layer.provideMerge(MirrorGateway.layer),
  Layer.provideMerge(RemotePlaneLive),
  Layer.provideMerge(WiresLive),
);

export const runtime = ManagedRuntime.make(AppLive, { memoMap: appMemoMap });
