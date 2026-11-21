// cloudflared.pid in the app's data folder: the pid of the app's tunnel
// connector, which Colibrii's tunnel writes. The next host ends a
// leftover one as it starts, and `sm doctor` reports it through these.
import { atoi } from "./doctorParse.ts";

export const TUNNEL_PID_FILE = "cloudflared.pid";

export const readTunnelPid = (raw: string): number | undefined =>
  atoi(raw.trim());
