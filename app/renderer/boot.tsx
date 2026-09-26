// The renderer's boot, one for both shells. Each entry hands over the
// two things that differ between a desktop window and a browser tab:
// the Clerk provider flavor (@clerk/electron/react rides the preload
// bridge for token storage and the system-browser OAuth transport,
// plain @clerk/react is the browser's) and the router history (memory
// in a window, real browser history in a tab). Everything else -- the
// query client, the device registry sync and each peer's push watch,
// the provider tree -- is the same boot. The wiring that only exists
// on a machine with projects of its own (this machine's push watch,
// the script run stream, the orphan sweep report, the worktree
// lifecycle, the port forwards) starts only where there is a local
// host.
//
// Callers must have installed window.api before importing this module:
// several renderer modules read the bridge at module scope (queryKeys'
// device id, the remote registry's local facts).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  focusManager,
  type QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { App } from "./App";
import { AppToaster } from "./components/AppChrome";
import { ErrorDetailsHost } from "./components/ui/inline-error";
import {
  ClerkGate,
  type ClerkProviderComponent,
} from "./components/account/ClerkGate";
import { watchPortForwards } from "./hooks/remote/usePortForwards";
import { createAppQueryClient } from "./lib/queryClientOptions";
import { hasLocalHost } from "./lib/localHost";
import { watchHost } from "./lib/hostWatch";
import { startRemoteDeviceSync } from "./lib/remote/remoteDeviceSync";
import { startVillagerMoves } from "./lib/villagers/moves";
import { startRemoteSweepRequests } from "./lib/remote/remoteSweep";
import { documentFocused } from "./lib/focus";
import { startSharedSettingsSync } from "./lib/remote/sharedSettingsSync";
import { localDeviceId, queryKeys, worktreeQueriesOn } from "./lib/queryKeys";
import { toast } from "./lib/toast";
import { createAppRouter, type AppRouter } from "./router";
import { scriptRuns } from "./store/scriptRuns";
import {
  onWorktreeRemoval,
  worktreeLifecycle,
} from "./store/worktreeLifecycle";
import {
  forgetDeletedWorktree,
  isOwnDeletePending,
} from "./hooks/worktrees/useWorktreeMutations";
import "./index.css";

// Not render blocking, unlike index.css (see fonts.css). A failed fetch
// leaves the fallback face, which is what text paints in meanwhile.
import("./fonts.css").catch(() => {});

export function bootApp({
  ClerkProvider,
  history,
}: {
  ClerkProvider: ClerkProviderComponent;
  history: RouterHistory;
}): AppRouter {
  // The shared config (defaults, global error toasts, the meta
  // opt-outs) lives in lib/queryClientOptions.ts.
  const queryClient = createAppQueryClient();
  const router = createAppRouter(history);

  // A removal announced by any device (this machine or a peer) gets
  // the treatment this window's own delete gives its worktree: its
  // in-flight fetches cancelled as the delete starts (settled, they
  // would answer "Unknown worktree" and toast), and its row and
  // queries dropped the moment it is gone, for every viewer at once.
  // This window's own delete is left to its mutation, which forgets
  // the row and routes off it together once the invoke replies. Both
  // shells: the web shell views peers' removals too.
  onWorktreeRemoval((deviceId, removal) => {
    if (isOwnDeletePending(queryClient, deviceId, removal.worktreeId)) return;
    if (removal.state === "removing") {
      void queryClient.cancelQueries({
        predicate: worktreeQueriesOn(deviceId, removal.worktreeId),
      });
    } else if (removal.state === "removed") {
      forgetDeletedWorktree(
        queryClient,
        deviceId,
        removal.projectId,
        removal.worktreeId,
      );
    }
  });

  if (hasLocalHost) startLocalHost(queryClient);

  // Mirror focus onto <html> so CSS can pause the infinite animations
  // (the doubutsu wallpaper drift, the spinners) while nobody is
  // looking: a running animation asks the compositor for a frame every
  // vsync, which was ~88% of the app's idle energy. Rides React Query's
  // focus signal (window focus/blur, visibilitychange, plus the
  // desktop's IPC channel wired in startLocalHost).
  syncFocusClass(documentFocused());
  focusManager.subscribe(syncFocusClass);

  // The shared settings exchange: this device's copy follows its peers'
  // and theirs follow it.
  startSharedSettingsSync(queryClient);

  // Remote devices: the remote device registry, rebuilt from the
  // account's device list plus the hub bridge status, on boot and on
  // every account or hub change. Each peer's pushes reach the cache
  // through the same watchHost this machine's do (startLocalHost),
  // from the moment the peer is first seen. On a hostless client that
  // is the ONLY thing keeping the forest live between focus refetches.
  startRemoteDeviceSync(queryClient, (deviceId, api) =>
    watchHost(queryClient, deviceId, api),
  );

  // The other direction: a host sweeps while someone is looking, and
  // this window says so to the hosts it is looking at.
  startRemoteSweepRequests();

  // Villagers moving in and out of any device's worktrees, told in
  // their voice whoever moved them (Village life).
  startVillagerMoves(queryClient);

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("#root element missing from index.html");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ClerkGate Provider={ClerkProvider}>
          <App router={router} />
        </ClerkGate>
        <AppToaster />
        <ErrorDetailsHost />
      </QueryClientProvider>
    </StrictMode>,
  );

  return router;
}

function syncFocusClass(focused: boolean): void {
  document.documentElement.classList.toggle("unfocused", !focused);
}

// The boot-scope subscriptions about THIS machine's projects. Single
// global subscriptions: events arrive whether or not any component is
// mounted (e.g. the carry-over failure toast must fire even if the user
// navigated away from the new worktree's detail page).
function startLocalHost(queryClient: QueryClient): void {
  // This machine's broadcasts, into its cache, exactly as a peer's
  // land in theirs.
  watchHost(queryClient, localDeviceId, window.api);
  scriptRuns.start();
  watchPortForwards(queryClient);

  // Scripts that survived a crash or a force quit are stopped by the
  // host at boot. Their consoles died with the session that started
  // them, so this toast is the only place the user can find out that a
  // dev server they left running is gone (and its port free again).
  void window.api.scripts
    .orphanReport()
    .then(({ stopped }) => {
      if (stopped === 0) return;
      toast.warning(
        `Stopped ${stopped} script${stopped === 1 ? "" : "s"} left running by a previous session`,
        {
          id: "orphan-scripts",
          description: "Shigoto no Mori closed while they were still running.",
        },
      );
    })
    .catch(() => undefined);

  // React Query's default focus listener subscribes to `window.focus`
  // and `visibilitychange`, but those don't fire on every Electron
  // focus transition (notably ⌘Tab back into the app, where focus
  // arrives at the BrowserWindow level rather than the document). Add
  // the window's IPC channel on top of the web events so
  // refetch-on-focus is reliable.
  focusManager.setEventListener((handleFocus) => {
    const onFocus = () => handleFocus(true);
    const onBlur = () => handleFocus(false);
    const onVisibility = () =>
      handleFocus(document.visibilityState === "visible");
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubFocus = window.api.window.onFocused(onFocus);
    const unsubBlur = window.api.window.onBlurred(onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubFocus();
      unsubBlur();
    };
  });

  // Boot warmth for the device config: the appearance providers moved
  // to the client store and no longer keep this query alive, but the
  // first paint of the launch gates (ScriptLaunchRow, the tidy page)
  // still reads it. Prefetch once so those mounts hit a warm cache.
  void queryClient.prefetchQuery({
    queryKey: queryKeys.globalConfig(),
    queryFn: () => window.api.globalConfig.read(),
  });

  // The host rewrote project.json (carry-over entries removed in favor
  // of .worktreeinclude); drop the caches that mirror it so open views
  // refresh.
  worktreeLifecycle.start({
    onCarryOverReconciled: (projectId) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.shigomoriConfig(projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.worktreeIncludeStatus(projectId),
      });
    },
  });
}
