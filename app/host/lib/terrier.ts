// Terrier integration (github.com/dittofleet/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. The merge is the CLI's (cli/terrier.go, read
// through `sm projects list`); what the app keeps is the readiness
// probe behind the Settings toggle: is terrier installed, and does
// `terrier ls --json` still answer in the shape the CLI reads. And
// `terrier add`, for the add-project dialog's offer to register a new
// project there too.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { TerrierReadiness } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
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

// What the bundled CLI reads out of `terrier ls --json`
// (parseTerrierListings in cli/terrier.go), so Settings calls the
// integration ready exactly when the merge would run.
const TerrierListingSchema = z.object({
  projects: z.array(z.object({ path: z.string() })),
});

const READINESS_CACHE_TTL_MS = 30_000;

// One spawn answers both questions: ENOENT is "not installed", and the
// output either parses as a listing or doesn't.
const readinessCache = ttlValueCache<TerrierReadiness>(
  READINESS_CACHE_TTL_MS,
  async () => {
    let stdout: string;
    try {
      ({ stdout } = await execTerrier(["ls", "--json"]));
    } catch (error) {
      const installed = (error as NodeJS.ErrnoException).code !== "ENOENT";
      return { installed, readable: false };
    }
    let listing: unknown;
    try {
      listing = JSON.parse(stdout);
    } catch {
      return { installed: true, readable: false };
    }
    return {
      installed: true,
      readable: TerrierListingSchema.safeParse(listing).success,
    };
  },
);

export function terrierReadiness(): Promise<TerrierReadiness> {
  return readinessCache.get();
}

// Registers a repo in terrier. Already registered is a success there.
// A refusal throws what terrier said, not execFile's command line.
export async function terrierAdd(path: string): Promise<void> {
  try {
    await execTerrier(["add", "--", path]);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const reason = stderr
      ? stderr.replace(/^Error: /, "")
      : errorMessageOf(error);
    throw new Error(`terrier add failed: ${reason}`, { cause: error });
  }
}

// For the global-config write flipping the toggle: the next read
// re-asks instead of serving up to a TTL of the pre-write world.
export function invalidateTerrierCaches(): void {
  readinessCache.expire();
}
