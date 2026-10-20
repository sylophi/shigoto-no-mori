// cloudflared.pid in the app's data folder: the pid of the app's tunnel
// connector. The next host reaps a leftover one (host/direct/Tunnel.ts)
// and `sm doctor` reports it, both through these two.
import { atoi } from "./doctorParse.ts";

export const tunnelPidText = (pid: number) => `${pid}\n`;

export const readTunnelPid = (raw: string): number | undefined =>
  atoi(raw.trim());
