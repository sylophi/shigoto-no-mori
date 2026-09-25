// Dev-only testing hook: SHIGOMORI_DIAL_KINDS=tunnel (a comma list of
// direct candidate kinds) limits which of a peer's candidates this
// device dials. Two dev profiles on one machine always meet over the
// LAN candidate, so the tunnel data path, and everything the host does
// only for a tunnel-borne connection, is otherwise unreachable without
// a second network. With it, one profile dials like a web client does.
// Unset, unknown names only, or a packaged build: every kind, as ever.
import { app } from "electron";
import {
  ALL_DIRECT_CANDIDATE_KINDS,
  type DirectCandidateKind,
} from "@shared/ipc/modules/direct";

export function devDialKinds(): DirectCandidateKind[] | undefined {
  const raw = process.env.SHIGOMORI_DIAL_KINDS;
  if (app.isPackaged || raw === undefined) return undefined;
  const wanted = new Set(raw.split(",").map((kind) => kind.trim()));
  const kinds = ALL_DIRECT_CANDIDATE_KINDS.filter((kind) => wanted.has(kind));
  if (kinds.length === 0) return undefined;
  console.info(`[direct] dev: dialing ${kinds.join(", ")} candidates only`);
  return kinds;
}
