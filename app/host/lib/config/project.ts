// A project's settings and a worktree's own data, in the store. The
// project-wide settings (scripts, layout, ...) are read and written
// through the engine's Config (host/lib/engineCalls.ts), as `sm projects
// config` does. A worktree's data is the custom ports the app adds and
// the title and description `sm describe` sets, each kept beside the
// other.
import type { ShigomoriConfig } from "@shigomori/contracts/schemas";
import * as Engine from "@host/lib/engine";
import { readProjectConfig } from "@host/lib/engineCalls";
import * as Ops from "@host/lib/engineOps";

// A worktree's key, for the caches keyed by one.
export function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export function parseWorktreeKey(key: string): {
  projectId: string;
  worktreeId: string;
} {
  const [projectId, worktreeId, ...extra] = key.split(":");
  if (projectId === undefined || worktreeId === undefined || extra.length > 0) {
    throw new Error(`worktree key ${key} is not projectId:worktreeId`);
  }
  return { projectId, worktreeId };
}

export function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  return readProjectConfig(projectId);
}

// The Promise face of the engine operations below (engineOps.ts), for
// the callers not converted yet: goes in step 7's B4c PR (V3.md, the
// host's Promise adapters).
export const readWorktreeData = (projectId: string, worktreeId: string) =>
  Engine.run(Ops.readWorktreeData(projectId, worktreeId));

export const writeWorktreeData = (
  ...args: Parameters<typeof Ops.writeWorktreeData>
) => Engine.run(Ops.writeWorktreeData(...args));

export const writeWorktreeDescription = (
  ...args: Parameters<typeof Ops.writeWorktreeDescription>
) => Engine.run(Ops.writeWorktreeDescription(...args));
