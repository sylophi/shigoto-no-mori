// cloudflared.pid in the app's data folder: the pid of the app's tunnel
// connector, which Colibrii's tunnel writes. The next host's tunnel
// reaps a leftover one, and `sm doctor` reports it through these.
import { atoi } from "./doctorParse.ts";

export const TUNNEL_PID_FILE = "cloudflared.pid";

export const readTunnelPid = (raw: string): number | undefined =>
  atoi(raw.trim());
