// Terrier integration (github.com/dittofleet/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. The merge is the CLI's (cli/terrier.go, read
// through `sm projects list`); what the app keeps is the readiness
// probe behind the Settings toggle: is terrier installed, and does its
// version speak the registry-read contract this build understands.
import * as Effect from "effect/Effect";
import type { TerrierReadiness } from "@shigomori/contracts/schemas";
import * as Processes from "./util/processes";
import { ttlValueCache } from "./util/ttlCache";

// A wedged terrier must not hang the Settings panel waiting on it.
const TERRIER_SPAWN_TIMEOUT_MS = 10_000;

// The registry-read contract the bundled CLI understands
// (terrierSupported* in cli/terrier.go, which decides whether the merge
// runs). Terrier's README says a tool checks the minor version and
// nothing else, so the toggle reports an unknown minor as incompatible
// rather than guessing.
const TERRIER_SUPPORTED_MAJOR = 0;
const TERRIER_SUPPORTED_MINOR = 1;

const READINESS_CACHE_TTL_MS = 30_000;

// One spawn answers both questions: a missing binary is "not
// installed", any output is the version to run the minor handshake
// against.
const readiness = Processes.exec("terrier", ["version"], {
  timeout: TERRIER_SPAWN_TIMEOUT_MS,
}).pipe(
  Effect.map(({ stdout }): TerrierReadiness => {
    const version = stdout.trim();
    return {
      installed: true,
      compatible: versionCompatible(version),
      version: version || undefined,
    };
  }),
  Effect.catchTags({
    CommandError: (error) =>
      Effect.succeed({
        installed: error.reason !== "not-found",
        compatible: false,
      }),
  }),
);

const readinessCache = ttlValueCache<TerrierReadiness>(
  READINESS_CACHE_TTL_MS,
  () => Processes.run(readiness),
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
