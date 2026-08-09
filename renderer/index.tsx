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
import { platform } from "./lib/platform";
import { queryKeys } from "./lib/queryKeys";
import { notifyError } from "./lib/toast";
import { scriptRuns } from "./store/scriptRuns";
import { worktreeLifecycle } from "./store/worktreeLifecycle";
import "./index.css";

// Tag the document with the OS so index.css can branch window-chrome
// styling (e.g. the sidebar paints an opaque surface on Windows where
// there's no vibrancy material behind it).
document.documentElement.dataset["platform"] = platform;

// Single global subscriptions: events arrive whether or not any
// component is mounted (e.g. carry-over failure toast must fire even
// if the user navigated away from the new worktree's detail page).
// worktreeLifecycle.start() needs queryClient and moves below it.
scriptRuns.start();

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
      // Hooks for genuinely-static data (runtime info) opt back in via
      // `staleTime: Infinity`.
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
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

// State changed on disk under the app (an CLI run in a terminal):
// invalidate the disk-derived queries so the sidebar reflects it
// without a focus change. Deliberately broad within that scope (the
// main process debounces the signal, and only active queries actually
// refetch), but network-backed and static domains sit it out: a disk
// change says nothing about GitHub or the updater, and refetching PR
// lists here turns every external write into a burst of gh calls.
const externalChangeExempt = new Set(["githubCli", "runtime", "updater"]);
window.api.git.onExternalChange(() => {
  void queryClient.invalidateQueries({
    predicate: (query) => !externalChangeExempt.has(String(query.queryKey[0])),
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
