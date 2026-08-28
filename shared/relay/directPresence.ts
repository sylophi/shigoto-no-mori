// The one rule scoping direct data-plane sessions to control-plane
// presence (v2 step 10, slice A): the relay brokers account
// membership, so a peer absent from a LIVE roster loses its direct
// sessions on both sides within seconds. This is what gives
// revocation teeth (a revoked device drops off the roster and its
// authed direct sockets die) without the direct wire growing its own
// revocation protocol.
//
// The gate matters as much as the closes: when OUR OWN relay link is
// down, the roster is not knowledge about the peers, it is knowledge
// about us, so acting on it would sever perfectly working direct
// connections during an account-relay outage. Extracted here (pure,
// electron-free) so main's presence wiring and the direct-plane check
// drive the identical rule.
export type DirectPresenceDeps = {
  // Kill the host-side authed direct sockets whose peer deviceId is
  // not in the roster (the ticket-mode listener's targeted close).
  // Optional because a platform with no direct listener (the web
  // client) has no host half at all.
  closeHostPeersNotIn?(online: readonly string[]): void;
  // Close and drop the cached outbound direct sessions for peers not
  // in the roster (the bridge's client half).
  dropClientPeersNotIn(online: readonly string[]): void;
  // Feed the keeper's desired set (shared/relay/directKeeper.ts): the
  // live roster, or [] when our own link is down. Runs AFTER the
  // closes so the keeper's eager dials for newly present peers start
  // against a pruned cache.
  reconcilePeers(online: readonly string[]): void;
};

export function applyDirectPresence(
  relayConnected: boolean,
  online: readonly string[],
  deps: DirectPresenceDeps,
): void {
  // No live roster, no verdicts: a downed relay socket reports an
  // empty roster, and closing on that would tear down every working
  // direct session exactly when the relay cannot help. The keeper DOES
  // reconcile to empty though (never the closes): it cannot dial
  // without the relay's broker leg anyway, an outage must cancel its
  // pending retries rather than let them burn against nothing, and the
  // post-reconnect roster then reads as all-new peers, whose eager
  // dials no-op through the cache for every session that survived the
  // outage and redial the rest -- including parked ones, so our own
  // link coming back is an unpark input.
  if (!relayConnected) {
    deps.reconcilePeers([]);
    return;
  }
  deps.closeHostPeersNotIn?.(online);
  deps.dropClientPeersNotIn(online);
  deps.reconcilePeers(online);
}
