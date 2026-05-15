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
import { App } from "./App";
import { notifyError } from "./lib/toast";
import { ensureScriptEventSubscription } from "./store/scriptRuns";
import "./index.css";

// Single global subscription for streamed script output. Components
// read per-key snapshots; main fires events for any run regardless of
// who initiated it (manual click vs auto-run on worktree create).
ensureScriptEventSubscription();

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
    queryMeta: {
      silentError?: boolean;
      errorTitle?: string;
      // Excludes this query from the global activity indicator. Use when
      // the query has its own local loading affordance (e.g. branches in
      // the dropdown popup).
      silentSpinner?: boolean;
    };
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
