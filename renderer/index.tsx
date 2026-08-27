import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App } from "./App";
import { createAppQueryClient } from "./lib/queryClientOptions";
import { startRemoteDeviceSync } from "./lib/remote/remoteDeviceSync";
import {
  invalidateHostDevice,
  localDeviceId,
  queryKeys,
} from "./lib/queryKeys";
import { toast } from "./lib/toast";
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

// The shared config (defaults, global error toasts, the meta opt-outs)
// lives in lib/queryClientOptions.ts, one module for both boots.
const queryClient = createAppQueryClient();

// Boot warmth for the device config: the appearance providers moved to
// the client store and no longer keep this query alive, but the first
// paint of the launch gates (ScriptLaunchRow, the tidy page) still
// reads it. Prefetch once so those mounts hit a warm cache.
void queryClient.prefetchQuery({
  queryKey: queryKeys.globalConfig(),
  queryFn: () => window.api.globalConfig.read(),
});

// Relay devices (v2 step 4, slice C): the remote device registry,
// rebuilt from the account's device list plus the relay bridge status,
// on boot and on every account or relay change.
startRemoteDeviceSync();

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
