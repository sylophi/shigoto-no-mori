import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  focusManager,
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Toaster } from "sonner";
import { isEntityGoneError } from "@shared/errors";
import { App } from "./App";
import { reconcileRemoteDevicesFromConfig } from "./lib/remote/registry";
import { startRelayDeviceSync } from "./lib/remote/relayDevices";
import { hostKeyDeviceId, queryKeyDomain, queryKeys } from "./lib/queryKeys";
import { notifyError, toast } from "./lib/toast";
import { scriptRuns } from "./store/scriptRuns";
import { worktreeLifecycle } from "./store/worktreeLifecycle";
import "./index.css";

// Single global subscriptions: events arrive whether or not any
// component is mounted (e.g. carry-over failure toast must fire even
// if the user navigated away from the new worktree's detail page).
// worktreeLifecycle.start() needs queryClient and moves below it.
scriptRuns.start();

// Scripts that survived a crash or a force quit are stopped by the main
// process at boot. Their consoles died with the session that started
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

// React Query's default focus listener subscribes to `window.focus` and
// `visibilitychange`, but those don't fire on every Electron focus
// transition (notably ⌘Tab back into the app, where focus arrives at
// the BrowserWindow level rather than the document). Add an Electron
// IPC channel on top of the web events so refetch-on-focus is reliable.
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

// Per-query opt-out: pass `meta: { silentError: true }` to suppress the
// global toast (use when the call site renders a richer inline error).
// `meta: { errorTitle: "Couldn't load X" }` overrides the default title.
declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { silentError?: boolean; errorTitle?: string };
    mutationMeta: { silentError?: boolean; errorTitle?: string };
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Local git/fs state can change at any moment via another tool;
      // there's no "TTL" that's meaningful. Refetch whenever an observer
      // mounts, the window regains focus, or a mutation invalidates us.
      // Hooks for genuinely-static data (runtime info, detected launchers,
      // project icons) opt out via their own staleTime. `true` rather than
      // "always": "always" short-circuits ahead of the staleness check, so it
      // silently defeats every staleTime a hook sets.
      refetchOnWindowFocus: true,
      refetchOnMount: true,
      staleTime: 0,
      // An entity-gone failure (project/worktree deleted out from under
      // an in-flight query) is deterministic; retrying only delays the
      // toast until well after the UI has moved on. Keep the default
      // three retries for everything else.
      retry: (failureCount, error) =>
        failureCount < 3 && !isEntityGoneError(error),
    },
  },
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (query.meta?.silentError) return;
      notifyError(query.meta?.errorTitle ?? "Something went wrong", err);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (mutation.meta?.silentError) return;
      notifyError(mutation.meta?.errorTitle ?? "Something went wrong", err);
    },
  }),
});

// Boot warmth for the device config: the appearance providers moved to
// the client store and no longer keep this query alive, but the first
// paint of the launch gates (ScriptLaunchRow, the tidy page) still
// reads it. Prefetch once so those mounts hit a warm cache.
void queryClient.prefetchQuery({
  queryKey: queryKeys.globalConfig(),
  queryFn: () => window.api.globalConfig.read(),
});

// Remote device registry (v2 step 3, slice C): read the local unredacted
// config once and reconcile the registry so every configured device
// starts connecting at boot. The token bearing doc is read imperatively
// inside this call and never enters the query cache. Re-reconcile after a
// remote-device write happens in the settings section that owns the list.
void reconcileRemoteDevicesFromConfig();

// Relay devices (v2 step 4, slice C): the same registry's other half,
// rebuilt from the account's device list plus the relay bridge status,
// on boot and on every account or relay change.
startRelayDeviceSync();

// State changed on disk under the app (an CLI run in a terminal):
// invalidate the disk-derived queries so the sidebar reflects it
// without a focus change. Deliberately broad within that scope (the
// main process debounces the signal, and only active queries actually
// refetch), but network-backed and static domains sit it out: a disk
// change says nothing about GitHub or the updater, and refetching PR
// lists here turns every external write into a burst of gh calls.
//
// The hygiene domains sit it out for cost, not scope: both cache for 60s
// (a sweep is several git calls or a directory walk per worktree) and
// invalidation ignores staleTime. Focus, mount and the removal flow
// still cover them.
//
// clientConfig sits it out for scope: the store lives in this app
// instance's userData and the CLI never writes it, so an external
// change over the shigomori root can't touch it. Including it would
// defeat the query's staleTime Infinity on every external CLI write.
const externalChangeExempt = new Set([
  "clientConfig",
  "githubCli",
  "runtime",
  "updater",
  "worktreeHygiene",
  "worktreeDiskUsage",
]);

// The external-change signal is this machine's git/fs watcher, so it
// speaks only to the local device's forest. A remote device's queries
// cache under ITS own id in the same host families, so leaving the
// predicate domain-only would invalidate a peer's worktrees on a purely
// local change. Gate host-scoped keys on the local device id. Client-
// scoped keys carry no id and keep the domain-exempt behavior unchanged.
const localDeviceId = window.api.deviceId;

window.api.git.onExternalChange(() => {
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const deviceId = hostKeyDeviceId(query.queryKey);
      if (deviceId !== undefined && deviceId !== localDeviceId) return false;
      return !externalChangeExempt.has(String(queryKeyDomain(query.queryKey)));
    },
  });
});

// Main rewrote project.json (carry-over entries removed in favor of
// .worktreeinclude); drop the caches that mirror it so open views refresh.
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

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster
        position="bottom-right"
        offset={{ bottom: 16, right: 16 }}
        closeButton
        toastOptions={{
          classNames: {
            toast:
              "!bg-popover !text-popover-foreground !border !border-border !shadow-md",
            title: "!select-text",
            description: "!text-muted-foreground !select-text",
            error: "!text-destructive",
            closeButton:
              "!left-auto !right-0 ![transform:translate(35%,-35%)] !bg-popover !text-muted-foreground !border-border hover:!bg-accent hover:!text-foreground",
          },
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
