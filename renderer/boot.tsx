// The renderer's boot, one for both shells. Each entry hands over the
// two things that differ between a desktop window and a browser tab:
// the Clerk provider flavor (@clerk/electron/react rides the preload
// bridge for token storage and the system-browser OAuth transport,
// plain @clerk/react is the browser's) and the router history (memory
// in a window, real browser history in a tab). Everything else -- the
// query client, the device registry sync, the peer push watch, the
// provider tree -- is the same boot. The wiring that only exists on a
// machine with projects of its own (the script run stream, the
// orphan sweep report, this machine's git watchers, the worktree
// lifecycle) starts only where there is a local host.
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
import {
  ClerkGate,
  type ClerkProviderComponent,
} from "./components/account/ClerkGate";
import { createAppQueryClient } from "./lib/queryClientOptions";
import { hasLocalHost } from "./lib/localHost";
import { startRemoteDeviceSync } from "./lib/remote/remoteDeviceSync";
import { startRemoteHostWatch } from "./lib/remote/remoteHostWatch";
import {
  invalidateHostDevice,
  invalidateHostProject,
  localDeviceId,
  queryKeys,
} from "./lib/queryKeys";
import { toast } from "./lib/toast";
import { createAppRouter, type AppRouter } from "./router";
import { scriptRuns } from "./store/scriptRuns";
import { worktreeLifecycle } from "./store/worktreeLifecycle";
import "./index.css";

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

  if (hasLocalHost) startLocalHost(queryClient);

  // Remote devices: the remote device registry, rebuilt from the
  // account's device list plus the hub bridge status, on boot and on
  // every account or hub change.
  startRemoteDeviceSync(queryClient);

  // A remote host's state moved (its app, its CLI, or a background
  // fetch there): invalidate that device's cached forest the same way
  // the local watcher signal does for this machine. On a hostless
  // client this is the ONLY thing keeping the forest live between
  // focus refetches.
  startRemoteHostWatch(queryClient);

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
      </QueryClientProvider>
    </StrictMode>,
  );

  return router;
}

// The boot-scope subscriptions about THIS machine's projects. Single
// global subscriptions: events arrive whether or not any component is
// mounted (e.g. the carry-over failure toast must fire even if the user
// navigated away from the new worktree's detail page).
function startLocalHost(queryClient: QueryClient): void {
  scriptRuns.start();

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

  // State changed on disk under the app (a CLI run in a terminal):
  // invalidate the disk-derived queries so the sidebar reflects it
  // without a focus change. window.api only ever carries this
  // machine's watcher signal, so the sweep is scoped to the local
  // device id. See invalidateHostDevice for the breadth and exemption
  // rationale.
  window.api.git.onExternalChange(() => {
    invalidateHostDevice(queryClient, localDeviceId);
  });
  // One project's git state moved on this machine (a commit or
  // checkout by an agent or a terminal, seen by the host's
  // git-directory watcher): refetch that project's rows only.
  window.api.git.onProjectChanged(({ projectId }) => {
    invalidateHostProject(queryClient, localDeviceId, projectId);
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
