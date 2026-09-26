// The one rule scoping direct data-plane sessions to control-plane
// presence: the device hub brokers account
// membership, so a peer absent from a LIVE roster loses its direct
// sessions on both sides within seconds. This is what gives
// revocation teeth (a revoked device drops off the roster and its
// authed direct sockets die) without the direct wire growing its own
// revocation protocol.
//
// The gate matters as much as the closes: when OUR OWN hub link is
// down, the roster is not knowledge about the peers, it is knowledge
// about us, so acting on it would sever perfectly working direct
// connections during an device-hub outage. Extracted here (pure,
// electron-free) so main's presence wiring and the direct-plane check
// drive the identical rule.
import {
  credentialRevoked,
  type SupervisorStatus,
} from "@shared/remote/supervisor";

type DirectPresenceDeps = {
  // Kill the host-side authed direct sockets whose peer deviceId is
  // not in the roster (the direct listener's targeted close).
  // Optional because a platform with no direct listener (the web
  // client) has no host half at all.
  closeHostPeersNotIn?(online: readonly string[]): void;
  // Close and drop the cached outbound direct sessions for peers not
  // in the roster (the bridge's client half).
  dropClientPeersNotIn(online: readonly string[]): void;
  // Feed the keeper's desired set (shared/hub/directKeeper.ts): the
  // live roster, or [] when our own link is down. Runs AFTER the
  // closes so the keeper's eager dials for newly present peers start
  // against a pruned cache.
  reconcilePeers(online: readonly string[]): void;
};

// What the hub socket's phase says about the direct sessions:
// - "roster": the socket is up, so the live roster is the verdict on
//   every peer, and a peer not in it loses its sessions.
// - "outage": the socket is down for a reason that says nothing about
//   this device's membership (dialing, backing off, a refused ticket,
//   a superseded socket, the idle moment before the first dial), so
//   the sessions ride it out.
// - "gone": this device has no account to speak of. The socket was
//   stopped on purpose (a sign-out, an account switch, which restarts
//   it under the new account's inputs) or the hub revoked the device.
//   Every direct session is a session with a peer of an account this
//   device is no longer in, so every one of them closes, the host-side
//   sockets included. Without this a sign-out would leave the sessions
//   to die by the peers' roster sweeps, and a peer whose own hub link
//   was down at the time would keep its session with us open.
export function directPresenceRule(
  socket: SupervisorStatus,
): "roster" | "outage" | "gone" {
  if (socket.phase === "connected") return "roster";
  if (socket.phase === "stopped" || credentialRevoked(socket)) return "gone";
  return "outage";
}

export function applyDirectPresence(
  socket: SupervisorStatus,
  online: readonly string[],
  deps: DirectPresenceDeps,
): void {
  const rule = directPresenceRule(socket);
  // No live roster, no verdicts: a downed hub socket reports an empty
  // roster, and closing on that would tear down every working direct
  // session exactly when the device hub cannot help. The keeper DOES
  // reconcile to empty though (never the closes): it cannot dial
  // without the device hub's connectInfo ask anyway, an outage must cancel
  // its pending retries rather than let them burn against nothing, and
  // the post-reconnect roster then reads as all-new peers, whose eager
  // dials no-op through the cache for every session that survived the
  // outage and redial the rest -- including parked ones, so our own
  // link coming back is an unpark input.
  if (rule === "outage") {
    deps.reconcilePeers([]);
    return;
  }
  // "gone" sweeps against an empty roster, whatever the stale link
  // still reports: every session closes.
  const roster = rule === "roster" ? online : [];
  deps.closeHostPeersNotIn?.(roster);
  deps.dropClientPeersNotIn(roster);
  deps.reconcilePeers(roster);
}
