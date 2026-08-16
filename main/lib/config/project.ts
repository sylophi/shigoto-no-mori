// Per-project on-disk state lives under ~/shigomori[-dev]/projects/<projectId>/:
//   project.json                       -- project-wide settings (scripts, layout, ...)
//   worktrees/<worktreeId>.json        -- per-worktree state (notes, ...)
// Shigomori manages these itself; we don't touch the user's repo. Per-worktree
// files exist for managed worktrees and the primary checkout (the main repo
// root); other external worktrees deliberately have no persisted state.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ShigomoriConfig,
  ShigomoriConfigSchema,
  type ShigomoriWorktreeData,
  ShigomoriWorktreeDataSchema,
} from "@shared/schemas";
import {
  atomicWriteJson,
  readJsonOrNull,
  unlinkIfExists,
} from "../util/jsonFile";
import { shigomoriRoot } from "../util/paths";
import { ttlMapCache } from "../util/ttlCache";

function projectDir(projectId: string): string {
  // Defense in depth: ids come from our own store, but this path feeds
  // a recursive rm (deleteProjectState). Refuse anything that could
  // escape the projects directory.
  if (/[\\/]/.test(projectId) || projectId.includes("..")) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return join(shigomoriRoot(), "projects", projectId);
}

function projectConfigPath(projectId: string): string {
  return join(projectDir(projectId), "project.json");
}

function worktreeDataPath(projectId: string, worktreeId: string): string {
  return join(projectDir(projectId), "worktrees", `${worktreeId}.json`);
}

// Failures aren't cached -- a bad config should error every read so the
// user notices and fixes it.
const configCache = ttlMapCache<string, ShigomoriConfig | null>(
  5_000,
  (projectId) =>
    readJsonOrNull(projectConfigPath(projectId), ShigomoriConfigSchema),
);

const worktreeCache = ttlMapCache<string, ShigomoriWorktreeData | null>(
  5_000,
  (key) => {
    const [projectId, worktreeId] = key.split(":");
    return readJsonOrNull(
      worktreeDataPath(projectId, worktreeId),
      ShigomoriWorktreeDataSchema,
    );
  },
);

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export async function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  return configCache.get(projectId);
}

// Bypasses the TTL cache. For read-modify-write callers (carry-over
// reconciliation) where a 5s-stale read could clobber a concurrent save.
export async function readShigomoriConfigFresh(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  configCache.invalidate(projectId);
  return configCache.get(projectId);
}

export async function writeShigomoriConfig(
  projectId: string,
  config: ShigomoriConfig,
): Promise<void> {
  await atomicWriteJson(
    projectConfigPath(projectId),
    ShigomoriConfigSchema.parse(config),
  );
  configCache.invalidate(projectId);
}

export async function readWorktreeData(
  projectId: string,
  worktreeId: string,
): Promise<ShigomoriWorktreeData | null> {
  return worktreeCache.get(worktreeKey(projectId, worktreeId));
}

export async function writeWorktreeData(
  projectId: string,
  worktreeId: string,
  data: ShigomoriWorktreeData,
): Promise<void> {
  await atomicWriteJson(
    worktreeDataPath(projectId, worktreeId),
    ShigomoriWorktreeDataSchema.parse(data),
  );
  worktreeCache.invalidate(worktreeKey(projectId, worktreeId));
}

export async function deleteWorktreeData(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = worktreeKey(projectId, worktreeId);
  try {
    await unlinkIfExists(worktreeDataPath(projectId, worktreeId));
  } finally {
    worktreeCache.invalidate(key);
  }
}

// For delegated CLI writes of project.json, which the state watcher
// suppresses as self-writes -- the handler drops the cache itself.
export function invalidateProjectConfigCache(projectId: string): void {
  configCache.invalidate(projectId);
}

// External processes (the CLI) write these files too; the state
// watcher calls this on any change under the root so the 5s TTL can't
// serve stale config after a CLI write.
export function invalidateAllProjectConfigCaches(): void {
  configCache.invalidateByPrefix("");
  worktreeCache.invalidateByPrefix("");
}

export async function deleteProjectState(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true });
  configCache.invalidate(projectId);
  // Drop every worktreeCache entry that belongs to this project so a
  // re-add can't ever see stale data through the in-memory layer.
  worktreeCache.invalidateByPrefix(`${projectId}:`);
}
