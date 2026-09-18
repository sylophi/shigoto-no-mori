// Reads .env.ports, the dotenv file port-pool writes this worktree's
// provisioned ports into (port-pool.config.json envFiles). Kept apart
// from .env.local so that file holds only the account service config
// and can be synced or mirrored between checkouts without dragging one
// checkout's ports into another. vite.renderer.config.ts pins the dev
// server to the PORT here and scripts/dev-peer.mts checks the dev
// build against it, so both read through this module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDotenv } from "./account/serviceConfig.ts";

// A real PORT env var wins over the provisioned one. Undefined when
// neither is set (port-pool not installed, or never run in `dir`):
// vite then picks its own port.
export function rendererDevServerPort(dir: string): string | undefined {
  if (process.env["PORT"]) return process.env["PORT"];
  try {
    return parseDotenv(readFileSync(join(dir, ".env.ports"), "utf8")).PORT;
  } catch {
    return undefined;
  }
}
