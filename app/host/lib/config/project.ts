// Per-project on-disk state lives under <dataDir>/projects/<projectId>/:
//   project.json                 project-wide settings (scripts, layout, ...)
//   worktrees/<worktreeId>.json  per-worktree state (title, ports, ...)
// Shigomori manages these itself; we don't touch the user's repo. Per-worktree
// files exist for managed worktrees and the primary checkout (the main repo
// root); other external worktrees deliberately have no persisted state.
// project.json is the CLI's: read through `sm projects config read` and
// written through `sm projects config write` (host/ipc/cliDelegate.ts).
// The per-worktree files are shared: the app writes the custom ports,
// and `sm describe` the title and description (cli/cmd_describe.go),
// each under the file's lock and keeping the other's keys.
import { join } from "node:path";
import * as Schema from "effect/Schema";
import {
  type ShigomoriConfig,
  type ShigomoriWorktreeData,
  ShigomoriWorktreeDataSchema,
  type WorktreeDescription,
} from "@shared/schemas";
import { shigomoriReadViaCli } from "@host/ipc/cliDelegate";
import {
  atomicWriteJsonSync,
  readJsonOrNull,
  readJsonOrNullSync,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { dataDir } from "../util/paths";
import { ttlMapCache } from "../util/ttlCache";

function projectDir(projectId: string): string {
  // Defense in depth: ids come from our own store, but refuse anything
  // that could escape the projects directory.
  if (/[\\/]/.test(projectId) || projectId.includes("..")) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return join(dataDir(), "projects", projectId);
}

function worktreeDataPath(projectId: string, worktreeId: string): string {
  return join(projectDir(projectId), "worktrees", `${worktreeId}.json`);
}

// Failures aren't cached. A bad config should error every read so the
// user notices and fixes it.
const configCache = ttlMapCache<string, ShigomoriConfig | null>(
  5_000,
  shigomoriReadViaCli,
);

const worktreeCache = ttlMapCache<string, ShigomoriWorktreeData | null>(
  5_000,
  (key) => {
    const { projectId, worktreeId } = parseWorktreeKey(key);
    return readJsonOrNull(
      worktreeDataPath(projectId, worktreeId),
      ShigomoriWorktreeDataSchema,
    );
  },
);

// A worktree's cache key, for the caches keyed by one.
export function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}:${worktreeId}`;
}

export function parseWorktreeKey(key: string): {
  projectId: string;
  worktreeId: string;
} {
  const [projectId, worktreeId, ...extra] = key.split(":");
  if (projectId === undefined || worktreeId === undefined || extra.length > 0) {
    throw new Error(`worktree cache key ${key} is not projectId:worktreeId`);
  }
  return { projectId, worktreeId };
}

export async function readShigomoriConfig(
  projectId: string,
): Promise<ShigomoriConfig | null> {
  return configCache.get(projectId);
}

export async function readWorktreeData(
  projectId: string,
  worktreeId: string,
): Promise<ShigomoriWorktreeData | null> {
  return worktreeCache.get(worktreeKey(projectId, worktreeId));
}

const decodeWorktreeData = Schema.decodeSync(ShigomoriWorktreeDataSchema);

// One read-modify-write of the data file under the lock the CLI
// takes, read fresh rather than through the cache: `sm describe` can
// have written it a moment ago.
function updateWorktreeData(
  projectId: string,
  worktreeId: string,
  update: (current: ShigomoriWorktreeData) => ShigomoriWorktreeData,
): void {
  const path = worktreeDataPath(projectId, worktreeId);
  withFileLock(`${path}.lock`, () => {
    const current = readJsonOrNullSync(path, ShigomoriWorktreeDataSchema) ?? {};
    // The decode strips anything it doesn't model, the marker
    // included, so it is stamped back on at the write rather than
    // carried through the schema.
    atomicWriteJsonSync(
      path,
      withSchemaVersion(decodeWorktreeData(update(current))),
    );
  });
  worktreeCache.invalidate(worktreeKey(projectId, worktreeId));
}

// The renderer's write: the custom ports, the rest of the document
// kept.
export async function writeWorktreeData(
  projectId: string,
  worktreeId: string,
  { ports }: Pick<ShigomoriWorktreeData, "ports">,
): Promise<void> {
  updateWorktreeData(projectId, worktreeId, (current) => ({
    ...current,
    ports,
  }));
}

// The title and description as a whole, the rest of the document kept:
// what a worktree carries to its copy on another device. Only a pair
// described after the one on disk lands, judged under the lock, so a
// carry that read a stale side can't undo a newer describe.
export async function writeWorktreeDescription(
  projectId: string,
  worktreeId: string,
  { title, description, describedAt }: WorktreeDescription,
): Promise<void> {
  updateWorktreeData(projectId, worktreeId, (current) =>
    (describedAt ?? 0) > (current.describedAt ?? 0)
      ? { ...current, title, description, describedAt }
      : current,
  );
}

// For delegated CLI writes of project.json, which the state watcher
// suppresses as self-writes. The handler drops the cache itself.
export function invalidateProjectConfigCache(projectId: string): void {
  configCache.invalidate(projectId);
}

// External processes (the CLI) write these files too; the state
// watcher calls this on any change under the data dir so the 5s TTL can't
// serve stale config after a CLI write.
export function invalidateAllProjectConfigCaches(): void {
  configCache.clear();
  worktreeCache.clear();
}
