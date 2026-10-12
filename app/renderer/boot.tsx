// The renderer's boot, one for both shells, in two parts: startApp once
// a page, for what its windows share (the atoms, the query client, the
// device registry sync and each peer's push watch), and mountWindow for
// each window drawn into it (its router and its provider tree): the one
// at the page's #root in the desktop app and the web client, several on
// the marketing site. Each entry hands over the two things that differ
// between a desktop window and a browser tab: the Clerk provider flavor
// (@clerk/electron/react rides the preload bridge for token storage and
// the system-browser OAuth transport, plain @clerk/react is the
// browser's) and the router history (memory in a window, real browser
// history in a tab). The wiring that only exists on a machine with
// projects of its own (this machine's push watch, the script run
// stream, the orphan sweep report, the worktree lifecycle, the port
// forwards) starts only where there is a local host. The entry hands
// over the page's api (lib/runtime/pageApi.tsx): startApp passes it to
// what it starts, and mountWindow puts it in the window's context.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  focusManager,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { windowContract } from "@shigomori/contracts/modules/window";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { App } from "./App";
import {
  accountsLeftAtom,
  clientLinksAtom,
  localDeviceIdAtom,
  peerSessionAtom,
  queryClientAtom,
} from "./lib/runtime/atoms";
import { ApiProvider, type RendererApi } from "./lib/runtime/pageApi";
import type { ClientLinks } from "./lib/runtime/ClientLinks";
import { AppToaster } from "./components/AppChrome";
import { UpdateNews } from "./components/UpdateNews";
import { ErrorDetailsHost } from "@shigomori/ui/primitives/inline-error.tsx";
import { OutsideProvider } from "@shigomori/ui/outside.tsx";
import { ThemeRootProvider } from "@shigomori/ui/root.tsx";
import {
  ClerkGate,
  type ClerkProviderComponent,
} from "./components/account/ClerkGate";
import { watchPortForwards } from "./hooks/remote/usePortForwards";
import { createAppQueryClient } from "./lib/queryClientOptions";
import { watchHost } from "./lib/hostWatch";
import {
  onAccountLeft,
  onSessionLanded,
  startRemoteDeviceSync,
} from "./lib/remote/remoteDeviceSync";
import { startVillagerMoves } from "./lib/villagers/moves";
import { startAgentWatch } from "./lib/agentWatch";
import { startRemoteSweepRequests } from "./lib/remote/remoteSweep";
import { openExternalUrl, revealInFolder } from "./lib/openExternal";
import { documentFocused } from "./lib/focus";
import { startSharedSettingsSync } from "./lib/remote/sharedSettingsSync";
import { toast } from "./lib/toast";
import { createAppRouter, type AppRouter } from "./router";
import { gitFetchingAtom } from "./hooks/git/useProjectGitFetching";
import { scriptRunsAtom, scriptRunsOf } from "./hooks/scripts/scriptRuns";
import { worktreeLifecycleAtom } from "./hooks/worktrees/useWorktreeLifecycle";
import "./app.css";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";

// Not render blocking, unlike app.css (see fonts.css). A failed fetch
// leaves the fallback face, which is what text paints in meanwhile.
import("@shigomori/ui/styles/fonts.css").catch(() => {});

// What the page's windows share.
export interface AppClient {
  api: RendererApi;
  registry: AtomRegistry.AtomRegistry;
  queryClient: QueryClient;
}

export function startApp({
  api,
  links,
}: {
  // The page's api, which the entry built.
  api: RendererApi;
  // The client's links (lib/runtime/client.ts), which the atoms' host
  // views ride.
  links: ClientLinks["Service"];
}): AppClient {
  // The shared config (defaults, global error toasts, the meta
  // opt-outs) lives in lib/queryClientOptions.ts.
  const queryClient = createAppQueryClient();
  // The page's atoms, over its client's links, for as long as the
  // page lives.
  const registry = AtomRegistry.make({
    initialValues: [
      [clientLinksAtom, links],
      [localDeviceIdAtom, api.deviceId],
      [queryClientAtom, queryClient],
    ],
  });
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) registry.dispose();
  });

  // A peer's views start again on each new session to it, and its
  // worktree lifecycle and git fetches are heard from the moment its
  // session lands until the account goes (worktreeLifecycleAtom and
  // gitFetchingAtom say why), in both shells: the web shell views
  // peers' removals and fetches too. What the atoms keep of a peer goes
  // with the account.
  const peerLifecycles = new Map<string, () => void>();
  onSessionLanded((deviceId) => {
    registry.update(peerSessionAtom(deviceId), (count) => count + 1);
    if (!peerLifecycles.has(deviceId)) {
      const lifecycle = registry.mount(worktreeLifecycleAtom(deviceId));
      const fetching = registry.mount(gitFetchingAtom(deviceId));
      peerLifecycles.set(deviceId, () => {
        lifecycle();
        fetching();
      });
    }
  });
  onAccountLeft(() => {
    for (const unmount of peerLifecycles.values()) unmount();
    peerLifecycles.clear();
    registry.update(accountsLeftAtom, (count) => count + 1);
  });

  followFocus(api);
  if (api.isElectron) startLocalHost(api, queryClient, registry);

  // The shared settings exchange: this device's copy follows its peers'
  // and theirs follow it.
  startSharedSettingsSync(api, registry);

  // Remote devices: the remote device registry, rebuilt from the
  // account's device list plus the hub bridge status, on boot and on
  // every account or hub change. Each peer's pushes reach the cache
  // through the same watchHost this machine's do (startLocalHost),
  // from the moment the peer is first seen. On a hostless client that
  // is the ONLY thing keeping the forest live between focus refetches.
  startRemoteDeviceSync(api, queryClient, registry, (deviceId, peer) =>
    watchHost(queryClient, deviceId, peer),
  );

  // The other direction: a host sweeps while someone is looking, and
  // this window says so to the hosts it is looking at.
  startRemoteSweepRequests(registry);

  // Villagers moving in and out of any device's worktrees, told in
  // their voice whoever moved them (Village life).
  startVillagerMoves(api, queryClient, registry);

  // Agent sessions on any device: the waiting ones for the Live page,
  // and on the desktop the notifications.
  startAgentWatch(api, registry);

  return { api, registry, queryClient };
}

// A window over the page's client, drawn into `element`, its theme
// root. With `themeFromRoot` the root's theme is the page's around it
// (a frame on the marketing site); otherwise the window wears its
// settings'.
export function mountWindow(
  { api, registry, queryClient }: AppClient,
  {
    element,
    ClerkProvider,
    history,
    themeFromRoot = false,
  }: {
    element: HTMLElement;
    ClerkProvider: ClerkProviderComponent;
    history: RouterHistory;
    themeFromRoot?: boolean;
  },
): AppRouter {
  const router = createAppRouter(history, element, api.isElectron);

  // Leaving a worktree's pages (the ones with a $worktreeId param) tells
  // its device's script runs, so a failure the sidebar marked while nobody was
  // there stops being news once they have been.
  const worktreeShown = () => {
    const params = router.state.matches.at(-1)?.params as
      | { deviceId?: string; worktreeId?: string }
      | undefined;
    return params?.worktreeId && params.deviceId
      ? { deviceId: params.deviceId, worktreeId: params.worktreeId }
      : null;
  };
  let shown = worktreeShown();
  router.subscribe("onResolved", () => {
    const next = worktreeShown();
    if (shown && shown.worktreeId !== next?.worktreeId) {
      scriptRunsOf(registry, shown.deviceId).markSeen(shown.worktreeId);
    }
    shown = next;
  });

  // Mirror focus onto the root so CSS can pause the infinite animations
  // (the doubutsu wallpaper drift, the spinners) while nobody is
  // looking: a running animation asks the compositor for a frame every
  // vsync, which was ~88% of the app's idle energy. Rides React Query's
  // focus signal (window focus/blur, visibilitychange, plus the
  // desktop's IPC channel, wired in followFocus).
  const syncFocusClass = (focused: boolean) =>
    element.classList.toggle("unfocused", !focused);
  syncFocusClass(documentFocused());
  focusManager.subscribe(syncFocusClass);

  // What a view opens outside the app goes through the host.
  const outside = {
    openUrl: (url: string, errorTitle?: string) =>
      openExternalUrl(api, url, errorTitle),
    revealInFolder: (path: string, errorTitle: string) =>
      revealInFolder(api, path, errorTitle),
  };

  createRoot(element).render(
    <StrictMode>
      <ApiProvider api={api}>
        <RegistryContext value={registry}>
          <QueryClientProvider client={queryClient}>
            <ThemeRootProvider value={element}>
              <OutsideProvider value={outside}>
                <ClerkGate Provider={ClerkProvider}>
                  <App router={router} themeFromRoot={themeFromRoot} />
                </ClerkGate>
                <AppToaster />
                <UpdateNews />
                <ErrorDetailsHost />
              </OutsideProvider>
            </ThemeRootProvider>
          </QueryClientProvider>
        </RegistryContext>
      </ApiProvider>
    </StrictMode>,
  );

  return router;
}

// The host probes its hub socket and every direct session, and dials at
// once what was waiting out a backoff, as on the shell's resume. Gone, a
// dead link reads as reconnecting within the probe's window rather than
// as connected until the heartbeat gives up.
function networkChanged(api: RendererApi): void {
  void api.run(api.window.networkChanged()).catch(() => undefined);
}

// The boot-scope subscriptions about THIS machine's projects. Events
// arrive whether or not any component is mounted (e.g. the carry-over
// failure toast must fire even if the user navigated away from the new
// worktree's detail page), so the atoms that hear them are mounted for
// the page's life.
function startLocalHost(
  api: RendererApi,
  queryClient: QueryClient,
  registry: AtomRegistry.AtomRegistry,
): void {
  // This machine's broadcasts, into its cache, exactly as a peer's
  // land in theirs.
  watchHost(queryClient, api.deviceId, api);
  registry.mount(scriptRunsAtom(api.deviceId));
  registry.mount(worktreeLifecycleAtom(api.deviceId));
  registry.mount(gitFetchingAtom(api.deviceId));
  watchPortForwards(api, queryClient);

  // Scripts that survived a crash or a force quit are stopped by the
  // host at boot. Their consoles died with the session that started
  // them, so this toast is the only place the user can find out that a
  // dev server they left running is gone (and its port free again).
  void api
    .run(api.scripts.orphanReport())
    .then(({ stopped }) => {
      if (stopped === 0) return;
      toast.warning(
        `Stopped ${pluralize(stopped, "script")} left running by a previous session`,
        {
          id: "orphan-scripts",
          description: "Shigoto no Mori closed while they were still running.",
        },
      );
    })
    .catch(() => undefined);

  // The network gone or back, as this window's Chromium sees it.
  window.addEventListener("online", () => networkChanged(api));
  window.addEventListener("offline", () => networkChanged(api));
}

// Whether someone is looking at the page, for React Query's focus
// refetches, the animations `.unfocused` pauses and the hosts' sweeps.
// React Query's own listener follows `visibilitychange` alone, so a tab
// behind another app's window would count as looked at and draw the
// wallpaper's drift every frame; the window's focus and blur say it. In
// Electron they don't fire on every focus transition (notably ⌘Tab back
// into the app, where focus arrives at the BrowserWindow level rather
// than the document), so the window's IPC channel comes on top.
function followFocus(api: RendererApi): void {
  focusManager.setEventListener((handleFocus) => {
    const onFocus = () => handleFocus(true);
    const onBlur = () => handleFocus(false);
    const onVisibility = () =>
      handleFocus(document.visibilityState === "visible");
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribes = api.isElectron
      ? [
          api.listen(api.pushes(windowContract, "focused"), onFocus),
          api.listen(api.pushes(windowContract, "blurred"), onBlur),
        ]
      : [];
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  });
}
