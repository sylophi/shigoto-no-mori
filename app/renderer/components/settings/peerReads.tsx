import {
  errorMessageOf,
  isCommandRefusedError,
} from "@shigomori/contracts/errors";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { useScopedDeviceLabel } from "@/hooks/remote/useRemoteDevices";
import { PeerReadErrorView } from "@shigomori/ui/views/settings/PeerReadErrorView.tsx";

// The sections that read a device's disk (the CLI, the agent hooks). Each
// read on a peer is a round trip for state that only the section's
// buttons and that machine's own terminal change; the mutations seed the
// cache from their replies and a landed session re-asks, so a peer's
// answer needs no focus refetch. This machine keeps the default: a
// terminal install shows on return.
export function peerStaleTime(remote: boolean): number {
  return remote ? Number.POSITIVE_INFINITY : 0;
}

// A peer's failed read, said in the section rather than the section
// just not being there. A refusal is the exception: that is the
// read-only state the page already explains. Locally the toast carries
// the error.
export function PeerReadError({
  error,
  what,
  heading,
}: {
  error: unknown;
  what: string;
  heading?: string;
}) {
  const { remote } = useHostScope();
  const device = useScopedDeviceLabel();
  if (!remote || !error || isCommandRefusedError(error)) return null;
  return (
    <PeerReadErrorView
      what={what}
      device={device}
      message={errorMessageOf(error)}
      heading={heading}
    />
  );
}
