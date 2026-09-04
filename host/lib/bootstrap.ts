// Initialize the data dir (~/.sm, ~/.smd) so it is browsable before the
// user has done anything. Idempotent: runs at launch, again at the tail
// of `nuke` (which just deleted it), and repairs a folder the user has
// deleted by hand.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateProjectConfigsToDirLayout } from "./projects/stateMigration";
import { withSchemaVersion } from "./util/jsonFile";
import { CONFIG_FILE, dataDir, STATE_FILE } from "./util/paths";

// The placeholders carry the schema marker like every other write, so
// even a data dir nobody has used yet says which shape it was made for.
const SEED_JSON = `${JSON.stringify(withSchemaVersion({}), null, 2)}\n`;

async function ensureFile(path: string, contents: string): Promise<void> {
  try {
    // `wx` fails if the file exists — race-safe "create if missing".
    await writeFile(path, contents, { flag: "wx", encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

// registry.json is deliberately not seeded here. Its existence is what
// tells the store that the registry has already been moved out of
// state.json (config/store.ts), so conjuring an empty one would let a
// data dir whose state.json has gone unreadable read back as "no projects"
// instead of failing. It appears on the first registry write, or on the
// split, whichever comes first.
export async function ensureDataDir(dir: string = dataDir()): Promise<void> {
  await mkdir(join(dir, "projects"), { recursive: true });
  await Promise.all([
    ensureFile(join(dir, CONFIG_FILE), SEED_JSON),
    ensureFile(join(dir, STATE_FILE), SEED_JSON),
    dir === dataDir() ? migrateProjectConfigsToDirLayout() : undefined,
  ]);
}
