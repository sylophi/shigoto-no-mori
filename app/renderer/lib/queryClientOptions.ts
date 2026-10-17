// One QueryClient configuration for both shells, built by the shared
// boot (renderer/boot.tsx). The default query behavior, the global error toasts, and the command-refusal
// branch that must run ahead of the silentError opt-out are platform
// independent, and hand-copying them is exactly how the web boot once
// dropped the refusal branch, so both boots build their client here.
import {
  isCancelledError,
  MutationCache,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";
import {
  isCommandRefusedError,
  isEntityGoneError,
  isHubRateLimitedError,
  isNoDirectConnectionError,
  isNotSharingError,
} from "@shigomori/contracts/errors";
import { isOwnAppDrop } from "@shared/remote/rpcTransport";
import { notifyError } from "@/lib/toast";
import { peerReadOnlyNote } from "@shigomori/ui/lib/commandAccessCopy.ts";

// What a cut action says: the call was lost with the process, which
// the window's band names (HostBand).
export const OWN_APP_DROP_WORDS =
  "The app's background process restarted before this finished. Try again.";

// Per-query opt-out: pass `meta: { silentError: true }` to suppress the
// global toast (use when the call site renders a richer inline error).
// `meta: { errorTitle: "Couldn't load X" }` overrides the default title.
declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: { silentError?: boolean; errorTitle?: string };
    mutationMeta: { silentError?: boolean; errorTitle?: string };
  }
}

// A read outside React (fetchQuery, ensureQueryData) of a query a page
// may be fetching too. Each query hands its call React Query's signal,
// so when the last page reading it goes, the fetch is cancelled and its
// call with it; a caller that joined that fetch asks again, up to
// `rejoins` times, after which the cancellation is its answer.
export function throughCancel<A>(
  read: () => Promise<A>,
  rejoins = 3,
): Promise<A> {
  return read().catch((error: unknown) =>
    isCancelledError(error) && rejoins > 0
      ? throughCancel(read, rejoins - 1)
      : Promise.reject(error),
  );
}

// The meta for a host read a peer serves only behind its command
// grant: a peer that has not granted this device control refuses it,
// which is a normal permission state its page renders as missing data,
// not an error to toast. On this machine a failure is a real one.
export function gatedHostReadMeta(remote: boolean, errorTitle: string) {
  return remote ? { silentError: true } : { errorTitle };
}

// `deviceLabelOf` names a peer by its id for the refusal toast.
export function createAppQueryClient(
  deviceLabelOf: (deviceId: string) => string | undefined,
): QueryClient {
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
        // an in-flight query) is deterministic, so retrying only keeps the
        // page waiting on an answer that cannot change. A command refusal
        // is deterministic too: the grant moves on the host's push, never
        // on a retry, and so is a peer not sharing. Keep the default three
        // retries for everything else. A read cut by this machine's own
        // host going away asks again for as long as it takes: the ask
        // waits for the link to land on the host that replaces it.
        // A read the hub's rate limiter turned away is asked once more,
        // after as long as the hub said; a mutation is never retried, so
        // no write is replayed.
        retryDelay: (failureCount, error) =>
          isHubRateLimitedError(error) && error.retryAfterSeconds !== undefined
            ? error.retryAfterSeconds * 1000
            : Math.min(1000 * 2 ** failureCount, 30_000),
        retry: (failureCount, error) =>
          isOwnAppDrop(error) ||
          (failureCount < (isHubRateLimitedError(error) ? 1 : 3) &&
            !isEntityGoneError(error) &&
            !isCommandRefusedError(error) &&
            !isNotSharingError(error)),
      },
    },
    queryCache: new QueryCache({
      onError: (err, query) => {
        if (query.meta?.silentError) return;
        // A peer's page stays mounted through a session blip, so its
        // queries fail this way until the keeper lands the session
        // again. The registry shows that, and remoteDeviceSync refetches
        // on the landing, so a toast per query per focus would only shout.
        if (isNoDirectConnectionError(err)) return;
        // A peer that just stopped sharing refuses whatever was still in
        // flight. Its status says so, and its cache is already dropped.
        if (isNotSharingError(err)) return;
        // A project or worktree deleted out from under an open page
        // (here, on the peer holding it, from the CLI) fails every
        // query the page had, each under its own title. Each page
        // renders its own missing state, so a toast per query would
        // only repeat that as errors.
        if (isEntityGoneError(err)) return;
        // Quiet for the same reason: the window's band says the host is
        // away, and the read is asked again.
        if (isOwnAppDrop(err)) return;
        notifyError(query.meta?.errorTitle ?? "Something went wrong", err);
      },
    }),
    mutationCache: new MutationCache({
      onError: (err, _vars, _ctx, mutation) => {
        // A read it joined was cancelled under it more times than
        // throughCancel joins again: nothing went wrong to say.
        if (isCancelledError(err)) return;
        // A command refusal (a remote host that hasn't granted this device
        // command access) is always worth surfacing plainly, ahead of the
        // silentError opt-out: the mutations that suppress the global toast
        // do so to show an inline retry/force prompt that doesn't apply to
        // a refusal, so silence would leave the click looking like a no-op.
        if (isCommandRefusedError(err)) {
          const label =
            err.deviceId === undefined
              ? undefined
              : deviceLabelOf(err.deviceId);
          notifyError(peerReadOnlyNote(label ?? "the other device"), err);
          return;
        }
        if (mutation.meta?.silentError) return;
        notifyError(
          mutation.meta?.errorTitle ?? "Something went wrong",
          isOwnAppDrop(err) ? OWN_APP_DROP_WORDS : err,
        );
      },
    }),
  });
}
