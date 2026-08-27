// Candidate addresses for the direct data plane's connectInfo answer
// (v2 step 10, slice A): every address a peer might reach this host's
// direct listener on. Deliberately dumb: all non-internal interface
// addresses, minus link-local (never routable to a peer that needs
// them), IPv4 first because it dials successfully more often on mixed
// networks. A Tailscale 100.x address, when present, appears here like
// any other interface address with no special handling. The dialer
// races or walks the list, so a dead candidate costs a timeout, never
// correctness.
//
// This file must stay Electron free (host:check). Node builtins are
// fine here.
import { networkInterfaces } from "node:os";

// The dialer walks candidates sequentially on a fixed budget, so a
// host with many virtual interfaces (Docker bridges, VPNs, VMs) must
// not eat the whole budget on junk. Cap what we advertise, IPv4 first,
// so a reachable LAN address is tried before the budget runs out.
const MAX_CANDIDATES = 6;

function isLinkLocal(address: string, family: string): boolean {
  if (family === "IPv4") return address.startsWith("169.254.");
  return address.toLowerCase().startsWith("fe80:");
}

export function candidateAddresses(): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (isLinkLocal(entry.address, entry.family)) continue;
      // Node appends a zone index to some IPv6 addresses. A zoned
      // address is only meaningful on THIS host, so it is skipped.
      if (entry.address.includes("%")) continue;
      (entry.family === "IPv4" ? v4 : v6).push(entry.address);
    }
  }
  return [...v4, ...v6].slice(0, MAX_CANDIDATES);
}
