// Terrier integration (github.com/sylophi/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. Terrier's stable surface is `terrier ls
// --json` plus the rule that a minor version bump is the compatibility
// signal, so that is all this file consumes. Ported alongside
// cli/terrier.go — the two engines must produce the same merged list
// or the app and the CLI would disagree about which projects exist.
//
// The registry read is a subprocess, but project resolution
// (findProjectOrThrow) is sync and hot — so reads go through a
// snapshot: async callers await refreshTerrierListings(), sync callers
// take the snapshot as-is (and kick a background refresh to keep it
// warm). The projects:list handler always refreshes first, and the
// renderer only ever learns a terrier project's id from that list, so
// by the time an id reaches a sync resolver the snapshot holds it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { TerrierReadiness } from "@shared/schemas";
import { readGlobalConfig } from "./config/global";
import { binaryOnPath } from "./util/binaries";
import { ttlValueCache } from "./util/ttlCache";

const execFileP = promisify(execFile);

const TERRIER_BINARY = "terrier";

// The registry-read contract this build understands. Terrier's README:
// "a tool checks the minor version and nothing else" — a minor bump
// means something a tool could be relying on has changed, so an
// unknown minor deactivates the merge rather than guessing. Mirror of
// terrierSupported* in cli/terrier.go.
const TERRIER_SUPPORTED_MAJOR = 0;
const TERRIER_SUPPORTED_MINOR = 1;

// One row of `terrier ls --json`. Slug (the GitHub owner/name) is
// absent for non-GitHub repos.
export interface TerrierListing {
  path: string;
  slug?: string;
}

const INSTALLED_CACHE_TTL_MS = 30_000;
const LIST_CACHE_TTL_MS = 15_000;

const installedCache = ttlValueCache(INSTALLED_CACHE_TTL_MS, () =>
  binaryOnPath(TERRIER_BINARY),
);

// "" when the binary is missing or the spawn fails.
const versionCache = ttlValueCache(INSTALLED_CACHE_TTL_MS, async () => {
  try {
    const { stdout } = await execFileP(TERRIER_BINARY, ["version"]);
    return stdout.trim();
  } catch {
    return "";
  }
});

function versionCompatible(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  return (
    Number(match[1]) === TERRIER_SUPPORTED_MAJOR &&
    Number(match[2]) === TERRIER_SUPPORTED_MINOR
  );
}

export async function terrierReadiness(): Promise<TerrierReadiness> {
  if (!(await installedCache.get())) {
    return { installed: false, compatible: false };
  }
  const version = await versionCache.get();
  return {
    installed: true,
    compatible: versionCompatible(version),
    version: version || undefined,
  };
}

// Empty whenever any gate is closed (toggle off, binary missing,
// version handshake failed) or the read fails — a broken terrier must
// degrade to "no terrier projects", never break project loading.
async function fetchListings(): Promise<TerrierListing[]> {
  const global = await readGlobalConfig();
  if (!global.terrier) return [];
  const readiness = await terrierReadiness();
  if (!readiness.installed || !readiness.compatible) return [];
  try {
    const { stdout } = await execFileP(TERRIER_BINARY, ["ls", "--json"]);
    const doc = JSON.parse(stdout) as { projects?: unknown };
    const rows = Array.isArray(doc.projects) ? doc.projects : [];
    return rows.flatMap((row: unknown): TerrierListing[] => {
      if (typeof row !== "object" || row === null) return [];
      const { path, slug } = row as { path?: unknown; slug?: unknown };
      if (typeof path !== "string" || path.length === 0) return [];
      return [{ path, slug: typeof slug === "string" ? slug : undefined }];
    });
  } catch (error) {
    console.warn("[terrier] ls --json failed:", error);
    return [];
  }
}

let snapshot: TerrierListing[] = [];
const listCache = ttlValueCache(LIST_CACHE_TTL_MS, fetchListings);

// fetchListings never throws, so neither does this.
export async function refreshTerrierListings(): Promise<TerrierListing[]> {
  snapshot = await listCache.get();
  return snapshot;
}

// For the sync callers (loadProjects and everything on top of it).
// Kicks a refresh so a stale snapshot converges even on a code path
// that never awaits one.
export function terrierListingsSnapshot(): TerrierListing[] {
  void refreshTerrierListings();
  return snapshot;
}

// For writers that change what the caches answer (the global-config
// write flipping the toggle): the next read re-asks instead of serving
// up to a TTL of the pre-write world.
export function invalidateTerrierCaches(): void {
  installedCache.invalidate();
  versionCache.invalidate();
  listCache.invalidate();
}

// Deterministic id for a terrier-sourced project: UUID-shaped from
// sha256(path) so the Go engine and this one mint the same id for the
// same path without ever writing it down. Uppercase like CLI-minted
// ids. Mirror of terrierProjectID in cli/terrier.go — keep the two
// byte-for-byte in sync (cli/terrier_test.go pins a vector).
export function terrierProjectId(path: string): string {
  const hex = createHash("sha256")
    .update(path)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
