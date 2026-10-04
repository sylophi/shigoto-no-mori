// Reads .env.ports, the dotenv file port-pool writes this worktree's
// provisioned ports into (port-pool.config.json envFiles). Kept apart
// from .env.local so that file holds only the account service config
// and can be synced or mirrored between checkouts without dragging one
// checkout's ports into another. Every dev server pins its port from
// here (the renderer, the web client, both fake host flavors), and
// scripts/dev-peer.mts and dev-device.mts find the renderer's through
// it, so all of them read through this module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { appRoot } from "./appRoot.mts";

// The web client and the two fake host flavors had fixed ports before
// port-pool covered them, and still fall back to those.
const FALLBACK_PORTS = {
  WEB_PORT: 5190,
  FAKE_HOST_PORT: 5191,
  FAKE_HOST_WEB_PORT: 5192,
};

type PortKey = "RENDERER_PORT" | keyof typeof FALLBACK_PORTS;

// A real env var of the same name wins over the provisioned one.
// Undefined when neither is set (port-pool not installed, or never run
// in this checkout).
function provisionedPort(key: PortKey): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const env = parseEnv(readFileSync(join(appRoot, ".env.ports"), "utf8"));
    return env[key] || undefined;
  } catch {
    return undefined;
  }
}

// Without one vite picks its own port.
export function rendererDevServerPort(): string | undefined {
  return provisionedPort("RENDERER_PORT");
}

// The renderer's dev server, where this worktree's port puts it.
export function rendererDevServerUrl(): string | undefined {
  const port = rendererDevServerPort();
  return port === undefined ? undefined : `http://localhost:${port}`;
}

// Whether that server answers, which is whether a primary dev app
// (`pnpm start`) is running in this worktree.
export function rendererDevServerAnswers(): Promise<boolean> {
  const url = rendererDevServerUrl();
  if (url === undefined) return Promise.resolve(false);
  return fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  );
}

export function fixedDevServerPort(key: keyof typeof FALLBACK_PORTS): number {
  return Number(provisionedPort(key) ?? FALLBACK_PORTS[key]);
}
