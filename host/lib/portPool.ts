// Port-pool integration. The user's port-pool tool keeps its per-project
// config at <project-or-worktree-root>/port-pool.config.json and its
// allocations at $XDG_DATA_HOME/port-pool/state.json (~/.local/share
// when unset). We activate the integration when the global toggle is
// on AND the config file parses as JSON with a recognizable
// schemaVersion field. Richer validation is left to port-pool itself.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PoolPort } from "@shared/ports/mergeWorktreePorts";
import { readGlobalConfig } from "./config/global";
import { binaryOnPath } from "./util/binaries";
import { ttlMapCache, ttlValueCache } from "./util/ttlCache";

const INSTALLED_CACHE_TTL_MS = 30_000;
// The ports section polls every few seconds per open detail page. A
// TTL past that interval means the state file is read once per window
// across every page, and a fresh provision still shows within it.
const STATE_CACHE_TTL_MS = 10_000;

const installedCache = ttlValueCache(INSTALLED_CACHE_TTL_MS, () =>
  binaryOnPath("port-pool"),
);

export function isPortPoolInstalled(): Promise<boolean> {
  return installedCache.get();
}

// Cached per directory like the state file: the ports list polls
// this, and the config changes about as often as the project does.
const configuredCache = ttlMapCache<string, boolean>(
  STATE_CACHE_TTL_MS,
  async (cwd) => {
    let raw: string;
    try {
      raw = await readFile(join(cwd, "port-pool.config.json"), "utf8");
    } catch {
      return false;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return "schemaVersion" in parsed;
    } catch {
      return false;
    }
  },
);

export function isPortPoolConfigured(cwd: string): Promise<boolean> {
  return configuredCache.get(cwd);
}

// The one decision for "is the port-pool integration on for this
// directory": the global toggle, the binary on PATH, and a parseable
// config in the directory. Both the portPool:isActive preflight and the
// ports list read it, so the toggle governs every integration point.
export async function isPortPoolEnabled(): Promise<boolean> {
  return (await readGlobalConfig()).portPool === true;
}

export async function isPortPoolActive(cwd: string): Promise<boolean> {
  if (!(await isPortPoolEnabled())) return false;
  const [installed, configured] = await Promise.all([
    isPortPoolInstalled(),
    isPortPoolConfigured(cwd),
  ]);
  return installed && configured;
}

// ---- allocations ----

// Only the fields the ports list needs, read loosely: port-pool owns
// this file and may grow it. `portOrder` is the declared order from the
// project's config, which is the order the user thinks in. `ports`
// alone is unordered.
const AllocationSchema = z.object({
  dir: z.string(),
  ports: z.record(z.string(), z.number().int().positive()),
  portOrder: z.array(z.string()).optional(),
});

const PortPoolStateSchema = z
  .object({
    allocations: z.array(z.unknown()).optional(),
  })
  .loose();

function portPoolStatePath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "port-pool", "state.json");
}

// Trailing separators aside, port-pool records the directory exactly as
// it was passed, and shigomori passes the worktree path git reports, so
// a plain string match is the honest comparison.
function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir;
}

// Keyed by the state file's path, so a change of XDG_DATA_HOME (the
// check's isolation, port-pool's own dev-run advice) is a different
// entry rather than a stale hit. Read as plain JSON, not through the
// shigomori JSON helper: the file is port-pool's, and its schemaVersion
// is port-pool's, so the helper's "written by a newer build" note
// would be about the wrong program.
const allocationsCache = ttlMapCache<string, Map<string, PoolPort[]>>(
  STATE_CACHE_TTL_MS,
  async (statePath) => {
    const byDir = new Map<string, PoolPort[]>();
    let state;
    try {
      state = PortPoolStateSchema.parse(
        JSON.parse(await readFile(statePath, "utf8")),
      );
    } catch {
      // Absent means port-pool has never run. Corrupt is port-pool's
      // problem to report. Here both mean no allocations are known.
      return byDir;
    }
    for (const entry of state.allocations ?? []) {
      const parsed = AllocationSchema.safeParse(entry);
      if (!parsed.success) continue;
      const { dir, ports, portOrder } = parsed.data;
      const names = [
        ...(portOrder ?? []).filter((name) => name in ports),
        ...Object.keys(ports).filter((name) => !portOrder?.includes(name)),
      ];
      byDir.set(
        normalizeDir(dir),
        names.map((name) => ({ name, port: ports[name] as number })),
      );
    }
    return byDir;
  },
);

// port-pool's allocation for a directory, in the project's declared
// order. Empty when the directory has none (or port-pool has never run).
export async function poolPortsFor(dir: string): Promise<PoolPort[]> {
  const allocations = await allocationsCache.get(portPoolStatePath());
  return allocations.get(normalizeDir(dir)) ?? [];
}
