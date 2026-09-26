// Terrier integration (github.com/sylophi/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. The merge is the CLI's (cli/terrier.go, read
// through `sm projects list`); what the app keeps is the readiness
// probe behind the Settings toggle: is terrier installed, and does its
// version speak the registry-read contract this build understands.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerrierReadiness } from "@shared/schemas";
import { ttlValueCache } from "./util/ttlCache";

const execFileP = promisify(execFile);

const TERRIER_BINARY = "terrier";
// A wedged terrier must not hang the Settings panel waiting on it.
const TERRIER_SPAWN_TIMEOUT_MS = 10_000;

function execTerrier(args: string[]): Promise<{ stdout: string }> {
  return execFileP(TERRIER_BINARY, args, {
    timeout: TERRIER_SPAWN_TIMEOUT_MS,
  });
}

// The registry-read contract the bundled CLI understands
// (terrierSupported* in cli/terrier.go, which decides whether the merge
// runs). Terrier's README says a tool checks the minor version and
// nothing else, so the toggle reports an unknown minor as incompatible
// rather than guessing.
const TERRIER_SUPPORTED_MAJOR = 0;
const TERRIER_SUPPORTED_MINOR = 1;

const READINESS_CACHE_TTL_MS = 30_000;

// One spawn answers both questions: ENOENT is "not installed", any
// output is the version to run the minor handshake against.
const readinessCache = ttlValueCache<TerrierReadiness>(
  READINESS_CACHE_TTL_MS,
  async () => {
    let version: string;
    try {
      ({ stdout: version } = await execTerrier(["version"]));
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

// For the global-config write flipping the toggle: the next read
// re-asks instead of serving up to a TTL of the pre-write world.
export function invalidateTerrierCaches(): void {
  readinessCache.expire();
}
