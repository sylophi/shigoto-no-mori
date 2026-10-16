import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import { HostBandView } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import { isOwnAppDrop } from "@shared/remote/rpcTransport";
import { hostAnswering, hostRestarted } from "@/lib/runtime/hostAnswering";

// How long the band says why the host restarted once it is back.
const RESTARTED_SHOWS_MS = 10_000;

// The band over the page while this machine's host is away, and for a
// moment after the shell started it again, saying why. As it comes
// back, the reads its going cut are asked again.
export function HostBand() {
  const answering = useExternalStore(hostAnswering);
  const restarted = useExternalStore(hostRestarted);
  const [expired, setExpired] = useState<typeof restarted>(null);
  const queryClient = useQueryClient();
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (answering && !wasAnswering.current) {
      void queryClient.refetchQueries({
        predicate: (query) =>
          query.state.status === "error" && isOwnAppDrop(query.state.error),
      });
    }
    wasAnswering.current = answering;
  }, [answering, queryClient]);

  useEffect(() => {
    if (restarted === null) return;
    const timer = setTimeout(() => setExpired(restarted), RESTARTED_SHOWS_MS);
    return () => clearTimeout(timer);
  }, [restarted]);

  if (!answering) return <HostBandView state={{ kind: "away" }} />;
  if (restarted !== null && restarted !== expired) {
    return (
      <HostBandView state={{ kind: "restarted", reason: restarted.reason }} />
    );
  }
  return null;
}
