// The merge behind ports:list: port-pool's rows first in their declared
// order, then the user-added rows that do not collide. A custom entry
// on a number port-pool also allocated is shadowed by the pool row
// rather than listed twice: the number is the identity a forward keys
// on, so one row per number. Pure and shared so the host handler, the
// lab bridge and the ports check all run the one rule.
import type { CustomPort, WorktreePort } from "@shared/schemas";

export type PoolPort = { name: string; port: number };
export type UnprobedWorktreePort = Omit<WorktreePort, "listening">;

export function mergeWorktreePorts(
  pool: readonly PoolPort[],
  custom: readonly CustomPort[],
): UnprobedWorktreePort[] {
  const seen = new Set<number>();
  const entries: UnprobedWorktreePort[] = [];
  for (const { name, port } of pool) {
    if (seen.has(port)) continue;
    seen.add(port);
    entries.push({ port, label: name, source: "pool" });
  }
  for (const { port, label } of custom) {
    if (seen.has(port)) continue;
    seen.add(port);
    entries.push({ port, label, source: "custom" });
  }
  return entries;
}
