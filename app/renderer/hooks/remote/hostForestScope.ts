// Which device a request reads, and over which api, for the queries a
// scoped caller (a useHostScope consumer, the sidebar's remote fan-out)
// runs on any device. Both default to the local machine, so a
// scope-less call reads this machine's, and a peer's data caches under
// its own id.
import { localDeviceId } from "@/lib/queryKeys";
import type { HostApi, HostScope } from "@/hooks/remote/useHostScope";

export type HostForestScope = Partial<HostScope>;

// The (device, api) pair a scope names. The api falls back to
// window.api only when the KEY is absent (a scope-less local call): a
// caller passing `api: undefined` means "this device has no
// connection", and a default parameter would silently swap the local
// api in, so every offline device would fetch and cache THIS machine's
// data under its own device key.
export function resolveForestScope(scope: HostForestScope): {
  deviceId: string;
  api: HostApi | undefined;
} {
  return {
    deviceId: scope.deviceId ?? localDeviceId,
    api: "api" in scope ? scope.api : window.api,
  };
}

// A fan-out's results as the fields consumers read, through
// useQueries' combine. Without one, useQueries hands back a fresh
// array of fresh objects every render, so nothing downstream can stay
// memoized; projecting routes it through replaceEqualDeep, which keeps
// identity when nothing changed.
export function combineFanOut<T>(
  results: readonly {
    data: T | undefined;
    error: Error | null;
    isLoading: boolean;
    isPending: boolean;
  }[],
) {
  return results.map((result) => ({
    data: result.data,
    error: result.error,
    isLoading: result.isLoading,
    isPending: result.isPending,
  }));
}
