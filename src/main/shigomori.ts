// Per-project on-disk state lives under ~/shigomori[-dev]/projects/<projectId>/:
//   project.json                       -- project-wide settings (scripts, layout, ...)
//   worktrees/<worktreeId>.json        -- per-worktree state (notes, ...)
// Shigomori manages these itself; we don't touch the user's repo. Per-worktree
// files only exist for managed worktrees -- externals deliberately have no
// persisted state.
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type ShigomoriConfig,
  ShigomoriConfigSchema,
  type ShigomoriWorktreeData,
  ShigomoriWorktreeDataSchema,
} from "@shared/schemas";
import { atomicWriteJson, readJsonOrNull } from "./jsonFile";
import { isENOENT, shigomoriRoot } from "./paths";
import { ttlMapCache } from "./ttlCache";

function projectDir(projectId: string): string {
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

// Best-effort: callers fire this on lifecycle events (delete, relocate-old-id)
// and shouldn't fail just because the file never existed.
export async function deleteWorktreeData(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await unlink(worktreeDataPath(projectId, worktreeId));
  } catch (err) {
    if (!isENOENT(err)) throw err;
  } finally {
    worktreeCache.invalidate(worktreeKey(projectId, worktreeId));
  }
}

// Nukes the entire project directory. Called on project removal so we
// don't leak per-project state across re-adds.
export async function deleteProjectState(projectId: string): Promise<void> {
  await rm(projectDir(projectId), { recursive: true, force: true });
  configCache.invalidate(projectId);
}
