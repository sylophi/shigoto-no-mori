// Dev-only testing hook: SHIGOMORI_DIAL_KINDS=tunnel (a comma list of
// direct candidate kinds) limits which of a peer's candidates this
// device dials. Two dev profiles on one machine always meet over the
// LAN candidate, so the tunnel data path, and everything the host does
// only for a tunnel-borne connection, is otherwise unreachable without
// a second network. With it, one profile dials like a web client does.
// Unset, unknown names only, or a packaged build: every kind, as ever.
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  type DirectCandidateKind,
} from "@shigomori/contracts/modules/direct";
import { log } from "@shared/log";
import { envSetting } from "@shared/config";
import { hostFacts } from "@host/process/facts";

export function devDialKinds(): DirectCandidateKind[] | undefined {
  const raw = envSetting("SHIGOMORI_DIAL_KINDS");
  if (hostFacts().packaged || raw === undefined) return undefined;
  const wanted = new Set(raw.split(",").map((kind) => kind.trim()));
  const kinds = ALL_DIRECT_CANDIDATE_KINDS.filter((kind) => wanted.has(kind));
  if (kinds.length === 0) return undefined;
  log.info(`[direct] dev: dialing ${kinds.join(", ")} candidates only`);
  return kinds;
}

// Dev-only testing hook: SHIGOMORI_DIRECT_FRONT_PORT=<port> advertises
// that port in place of the direct listener's, in the LAN candidates
// and the tunnel's ingress, so a proxy there (the reliability lab's)
// carries every connection a peer makes to this device and can drop
// them. Unset, not a port, or a packaged build: the listener's own.
export function devFrontPort(listenerPort: number): number {
  const raw = envSetting("SHIGOMORI_DIRECT_FRONT_PORT");
  if (hostFacts().packaged || raw === undefined) return listenerPort;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536
    ? port
    : listenerPort;
}
