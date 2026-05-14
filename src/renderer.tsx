import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App } from "./App";
import { notifyError } from "./lib/toast";
import "./index.css";

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
        toastOptions={{
          classNames: {
            toast:
              "!bg-popover !text-popover-foreground !border !border-border !shadow-md",
            description: "!text-muted-foreground",
            error: "!text-destructive",
          },
        }}
      />
    </QueryClientProvider>
  </StrictMode>,
);
