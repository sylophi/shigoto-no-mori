// The services the root reaches from the callbacks it hands host code
// that is not Effect yet (bridge.ts), each with the few calls the root
// makes on it. Each capture's layer sits beside its service in the
// graph (layer.ts, wires.ts).
import type { MirrorCreateInput } from "@host/mirror/registry";
import * as Tunnel from "@host/direct/cloudflared";
import * as GitWatcher from "@host/lib/gitWatcher";
import type * as GithubCli from "@host/lib/githubCli/GithubCli";
import { refreshProjectPullRequests } from "@host/lib/githubCli/pullRequests";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostPushes from "@host/lib/hostPushes";
import * as Sharing from "@host/lib/sharing";
import * as Terminals from "@host/lib/terminals/Terminals";
import * as MirrorDaemon from "@host/mirror/daemon";
import * as Loopback from "@host/socket/loopback";
import * as DeviceLink from "@host/socket/server";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import * as Effect from "effect/Effect";
import * as ScriptsLib from "@host/lib/scripts";
import * as Bridge from "./bridge";

// Every broadcast publishes here. Synchronous, so pushes keep their
// order. Before the graph is up nobody can be listening, and the push
// goes nowhere.
export const pushes = Bridge.capture<HostPushes.HostPushes>("The host pushes");
export const publishPush = (push: HostPushes.Push) =>
  pushes.readNow(
    Effect.flatMap(HostPushes.HostPushes, (it) => it.publish(push)),
    () => undefined,
  );

export const sharing = Bridge.capture<Sharing.Sharing>("The sharing switch");
// Before the graph is up the link serves nobody, so it reads as off.
export const sharesData = () =>
  sharing.readNow(
    Effect.flatMap(Sharing.Sharing, (it) => it.current),
    () => false,
  );

export const storeChanges =
  Bridge.capture<StoreChanges.StoreChanges>("The store changes");
// For the data-folder move. Changes that are not up have nothing to
// release.
export const releaseStore = () =>
  storeChanges.runIfUp(
    Effect.flatMap(StoreChanges.StoreChanges, (it) => it.release),
  );

export const gitWatcher =
  Bridge.capture<GitWatcher.GitWatcher>("The git watcher");
export const reconcileGitWatchers = (): void => {
  void gitWatcher
    .run(Effect.flatMap(GitWatcher.GitWatcher, (it) => it.reconcile))
    .catch(() => {});
};

// For the data-folder move and the data wipe.
export const loopback = Bridge.capture<Loopback.Loopback>("The loopback");
export const loopbackAddress = () =>
  loopback.run(Effect.flatMap(Loopback.Loopback, (it) => it.address));
export const unpublishLoopback = () =>
  loopback.runIfUp(Effect.flatMap(Loopback.Loopback, (it) => it.unpublish));
export const publishLoopback = () =>
  loopback.runIfUp(Effect.flatMap(Loopback.Loopback, (it) => it.publish));

export const deviceLink =
  Bridge.capture<DeviceLink.DeviceLink>("The device link");
export const directLink = {
  // `resolve` reads the wanted state inside the serialized reconcile.
  refresh: (resolve: () => Promise<DeviceLink.WsServerStartOpts | null>) =>
    deviceLink.run(
      Effect.flatMap(DeviceLink.DeviceLink, (link) =>
        link.reconcile(Effect.promise(resolve)),
      ),
    ),
  status: () =>
    deviceLink.readNow(
      Effect.flatMap(DeviceLink.DeviceLink, (link) => link.status),
      () => ({ listening: false, port: null, bindAddress: null, error: null }),
    ),
  closePeersNotIn: (online: readonly string[]) =>
    deviceLink.runIfUp(
      Effect.flatMap(DeviceLink.DeviceLink, (link) =>
        link.closePeersNotIn(online),
      ),
    ),
};

export const tunnelCapture = Bridge.capture<Tunnel.Tunnel>("The tunnel");
export const tunnel = {
  // Nothing to reconcile once the app is quitting: the layer's close
  // has stopped the child.
  reconcile: (wanted: { readonly port: number } | null) =>
    tunnelCapture
      .run(Effect.flatMap(Tunnel.Tunnel, (t) => t.reconcile(wanted)))
      .catch(() => undefined),
  state: () =>
    tunnelCapture.readNow(
      Effect.flatMap(Tunnel.Tunnel, (t) => t.status),
      () => ({ state: "off" as const, hostname: null }),
    ).state,
  tunnelUrl: () =>
    tunnelCapture.readNow(
      Effect.flatMap(Tunnel.Tunnel, (t) => t.tunnelUrl),
      () => null,
    ),
};

// The daemon the mirror registry's impl runs on (handlers.ts).
export const daemon =
  Bridge.capture<MirrorDaemon.MirrorDaemon>("The mirror daemon");
const onDaemon = MirrorDaemon.onDaemon;
export const mirrorDaemon = {
  status: () =>
    daemon.readNow(
      onDaemon((it) => it.status),
      () => "stopped" as const,
    ),
  sessions: () =>
    daemon.readNow(
      onDaemon((it) => it.sessions),
      () => [],
    ),
  create: (input: MirrorCreateInput) =>
    daemon.run(onDaemon((it) => it.create(input))),
  terminate: (session: string) =>
    daemon.run(onDaemon((it) => it.terminate(session))),
  pause: (session: string) => daemon.run(onDaemon((it) => it.pause(session))),
  resume: (session: string) => daemon.run(onDaemon((it) => it.resume(session))),
};

export const terminals = Bridge.capture<Terminals.Terminals>("The terminals");
// What a quit asks about.
export const busyTerminals = () =>
  terminals
    .run(Effect.flatMap(Terminals.Terminals, (it) => it.busy))
    .catch(() => 0);
export const closeMissingTerminals = () =>
  terminals.runIfUp(
    Effect.flatMap(Terminals.Terminals, (it) => it.closeMissing),
  );

// gh, for the background fetch's sweep of each project's pull requests.
export const github = Bridge.capture<
  GithubCli.GithubCli | ChildProcessSpawner.ChildProcessSpawner
>("gh");
export const refreshPullRequests = (projectPath: string) =>
  github.run(refreshProjectPullRequests(projectPath));

// The scripts' kill chains and the sweep of removed worktrees' scripts,
// for the store watcher's callback and the data-folder move and wipe.
export const scripts =
  Bridge.capture<ChildProcessSpawner.ChildProcessSpawner>("The scripts");
export const killAllScripts = () => scripts.run(ScriptsLib.killAllScripts());
