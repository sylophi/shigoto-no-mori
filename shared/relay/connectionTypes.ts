// The relay connection's public option and status shapes, shared so the
// node desktop connection (host/relay/connection.ts) and the browser
// connection (web/relay/connection.ts) carry one definition rather than
// two that could drift. Pure types only: no runtime, no node, no
// electron, so both a host build and a browser build compile against it.
import type { SupervisorStatus } from "@shared/remote/supervisor";

export type RelayConnectOpts = {
  // Base URL of the relay Worker (http(s) or ws(s) scheme, converted
  // to ws(s) by the connection).
  relayUrl: string;
  // The signed-in account this socket belongs to. Compared so signing
  // into a DIFFERENT account (which rotates the credential) forces a
  // reconnect rather than leaving the old socket live on the old
  // account's DO.
  accountId: string;
  // Mints one single-use connect ticket. Injected so the connection never
  // touches the credential store: the owner composes it from the account
  // layer, and a fresh ticket is minted per connect attempt. The signal
  // aborts the mint on stop or on the mint timeout.
  mintTicket(signal: AbortSignal): Promise<string>;
  // This device's id and app version, the identity peers see in the sm
  // hello/welcome handshake.
  deviceId: string;
  appVersion: string;
};

export type RelayConnectionStatus = {
  // The relay socket's supervisor phase. On the connected phase the
  // remote identity fields are empty: the DO has no sm welcome, its
  // accept signal is the first presence envelope.
  socket: SupervisorStatus;
  // The account's online deviceIds from the latest presence broadcast,
  // the local device filtered out, empty whenever the socket is down.
  // Peer app versions are NOT here: relay client peers are transient
  // broker sessions now, so the welcome-confirmed versions the status
  // surface reports come from the cached direct sessions
  // (shared/relay/directPlane.ts).
  onlineDeviceIds: string[];
};
