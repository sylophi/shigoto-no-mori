import { useEffect, useState } from "react";
import { useExternalStore } from "@shigomori/ui/lib/externalStore.ts";
import { HostBandView } from "@shigomori/ui/views/hostBand/HostBandView.tsx";
import { hostAnswering, hostRestarted } from "@/lib/runtime/hostAnswering";

// How long the band says why the host restarted once it is back.
const RESTARTED_SHOWS_MS = 10_000;

// The band over the page while this machine's host is away, and for a
// moment after the shell started it again, saying why (the reads its
// going cut are asked again by askAgainOnHostReturn).
export function HostBand() {
  const answering = useExternalStore(hostAnswering);
  const restarted = useExternalStore(hostRestarted);
  const [expired, setExpired] = useState<typeof restarted>(null);

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
