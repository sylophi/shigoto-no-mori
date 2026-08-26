// One QueryClient configuration for both entry points, the desktop boot
// (renderer/index.tsx) and the web boot (web/app/boot.tsx). The default
// query behavior, the global error toasts, and the command-refusal
// branch that must run ahead of the silentError opt-out are platform
// independent, and hand-copying them is exactly how the web boot once
// dropped the refusal branch, so both boots build their client here.
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isEntityGoneError } from "@shared/errors";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { notifyError } from "@/lib/toast";

// Per-query opt-out: pass `meta: { silentError: true }` to suppress the
// global toast (use when the call site renders a richer inline error).
// `meta: { errorTitle: "Couldn't load X" }` overrides the default title.
declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { silentError?: boolean; errorTitle?: string };
    mutationMeta: { silentError?: boolean; errorTitle?: string };
  }
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
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
}
