// What a peer's view ends with, as this host serves it to a window
// (hub:watchPeer). The link to the peer going (its host restarting, the
// network) or failing to dial is the redial's to mend: it crosses as no
// session, which a view asks again on. The peer's own failure (a
// refusal, an answer this build can't read) ends the view as it is.
import { NoDirectConnectionError } from "@shigomori/contracts/errors";
import { RemoteConnectError } from "@shared/remote/deviceLink";
import { RemoteDisconnectedError } from "@shared/remote/rpcTransport";

export const peerViewFailure = (deviceId: string, failure: unknown) =>
  failure instanceof RemoteConnectError ||
  failure instanceof RemoteDisconnectedError
    ? new NoDirectConnectionError({ deviceId })
    : failure;
