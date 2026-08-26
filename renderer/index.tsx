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
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { App } from "./App";
import { reconcileRemoteDevicesFromConfig } from "./lib/remote/registry";
import { startRelayDeviceSync } from "./lib/remote/relayDevices";
import {
  invalidateHostDevice,
  localDeviceId,
  queryKeys,
} from "./lib/queryKeys";
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
      // A command refusal (a remote host that hasn't granted this device
      // command access) is always worth surfacing plainly, ahead of the
      // silentError opt-out: the mutations that suppress the global toast
      // do so to show an inline retry/force prompt that doesn't apply to
      // a refusal, so silence would leave the click looking like a no-op.
      if (isCommandRefusedError(err)) {
        notifyError(
          "That machine hasn't granted this device command access",
          err,
        );
        return;
      }
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

// State changed on disk under the app (a CLI run in a terminal):
// invalidate the disk-derived queries so the sidebar reflects it
// without a focus change. window.api only ever carries this machine's
// watcher signal, so the sweep is scoped to the local device id. See
// invalidateHostDevice for the breadth and exemption rationale.
window.api.git.onExternalChange(() => {
  invalidateHostDevice(queryClient, localDeviceId);
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
