// The tab's trace of its remote plane: a console line each time the hub
// socket changes phase or a peer's direct session goes, so the devtools
// console (the web client's only log) shows what happened to the
// connection, in order, beside the keeper's lines for a session's dial
// failing and landing.
import type { HubStatus } from "@shigomori/contracts/modules/hub";
import { log } from "@shared/log";

function socketLine(socket: HubStatus["socket"]): string {
  switch (socket.phase) {
    case "backoff":
      return `backoff (attempt ${socket.attempt}, next dial in ${Math.round(socket.delayMs)} ms)`;
    case "blocked":
      return `blocked (${socket.reason}: ${socket.message})`;
    default:
      return socket.phase;
  }
}

// Returns the tracer for one tab: each call compares the snapshot with
// the last one it saw.
export function createHubTrace(): (status: HubStatus) => void {
  let lastSocket = "";
  let lastSessions = new Set<string>();
  return (status) => {
    const socket = socketLine(status.socket);
    if (socket !== lastSocket) {
      const line = `[hub] socket ${socket}`;
      if (status.socket.phase === "blocked") log.warn(line);
      else log.info(line);
      lastSocket = socket;
    }
    const sessions = new Set(Object.keys(status.peerAppVersions));
    for (const deviceId of lastSessions) {
      if (!sessions.has(deviceId)) {
        log.info(`[direct] session to ${deviceId} closed`);
      }
    }
    lastSessions = sessions;
  };
}
