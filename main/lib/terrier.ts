// Terrier integration (github.com/sylophi/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. Terrier's stable surface is `terrier ls
// --json` plus the rule that a minor version bump is the compatibility
// signal, so that is all this file consumes. Ported alongside
// cli/terrier.go — the two engines must produce the same merged list
// or the app and the CLI would disagree about which projects exist.
//
// The registry read is a subprocess, but project resolution
// (findProjectOrThrow) is sync and hot — so sync callers read the
// cache's last-known value via peek() while async ones await a
// refresh. The projects:list handler always refreshes first, and the
// renderer only ever learns a terrier project's id from that list, so
// by the time an id reaches a sync resolver the cache holds it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { TerrierReadiness } from "@shared/schemas";
import { readGlobalConfig } from "./config/global";
import { toAbsolute } from "./util/paths";
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

// `terrier ls --json` rows. Local to this module on purpose: it
// describes another tool's output, not this app's IPC contract, so it
// doesn't belong in the shared barrel (same as GhPrListItemSchema in
// githubCli/pullRequests.ts).
const TerrierListingSchema = z.object({ path: z.string().min(1) });
const TerrierLsSchema = z.object({
  projects: z.array(TerrierListingSchema),
});
export type TerrierListing = z.infer<typeof TerrierListingSchema>;

const READINESS_CACHE_TTL_MS = 30_000;
const LIST_CACHE_TTL_MS = 15_000;

// One spawn answers both questions: ENOENT is "not installed", any
// output is the version to run the minor handshake against.
const readinessCache = ttlValueCache<TerrierReadiness>(
  READINESS_CACHE_TTL_MS,
  async () => {
    let version: string;
    try {
      ({ stdout: version } = await execFileP(TERRIER_BINARY, ["version"]));
    } catch (error) {
      const installed = (error as NodeJS.ErrnoException).code !== "ENOENT";
      return { installed, compatible: false };
    }
    version = version.trim();
    return {
      installed: true,
      compatible: versionCompatible(version),
      version: version || undefined,
    };
  },
);

function versionCompatible(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  return (
    Number(match[1]) === TERRIER_SUPPORTED_MAJOR &&
    Number(match[2]) === TERRIER_SUPPORTED_MINOR
  );
}

export function terrierReadiness(): Promise<TerrierReadiness> {
  return readinessCache.get();
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
    const parsed = TerrierLsSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      console.warn("[terrier] unrecognized ls --json shape:", parsed.error);
      return [];
    }
    // Normalized like every other path entering the project layer, so
    // the registry dedupe and the id hash can't be defeated by a
    // spelling difference. Mirrors the toAbsolute in cli/terrier.go.
    return parsed.data.projects.map((p) => ({ path: toAbsolute(p.path) }));
  } catch (error) {
    console.warn("[terrier] ls --json failed:", error);
    return [];
  }
}

const listCache = ttlValueCache(LIST_CACHE_TTL_MS, fetchListings);

// fetchListings never throws, so neither does this.
export async function refreshTerrierListings(): Promise<void> {
  await listCache.get();
}

// For the sync callers (loadProjects and everything on top of it):
// the last-known listings, which invalidateTerrierCaches drops. Stale
// past the TTL until an async caller refreshes — better than absent,
// which would make every terrier project id transiently unresolvable.
export function terrierListingsSnapshot(): TerrierListing[] {
  return listCache.peek() ?? [];
}

// Whether the last-known terrier listings hold path. False whenever
// the integration is off or unrefreshed — callers use this to decide
// id continuity, and "don't know" must act like "no". Mirror of
// terrierHasPath in cli/terrier.go.
export function terrierHasPath(path: string): boolean {
  return terrierListingsSnapshot().some((t) => t.path === path);
}

// Whether the project would live on as a terrier-sourced project with
// the same id after its registry entry is dropped — the rule the
// remove flow uses to decide that nothing is actually going away.
// Mirror of terrierRetains in cli/terrier.go.
export function terrierRetainsProject(project: {
  id: string;
  path: string;
}): boolean {
  return (
    terrierHasPath(project.path) &&
    terrierProjectId(project.path) === project.id
  );
}

// For writers that change what the caches answer (the global-config
// write flipping the toggle): the next read re-asks instead of serving
// up to a TTL of the pre-write world.
export function invalidateTerrierCaches(): void {
  readinessCache.invalidate();
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
