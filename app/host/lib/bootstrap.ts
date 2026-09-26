// Initialize the data dir (~/.sm, ~/.smd) so it is browsable before the
// user has done anything. Idempotent: runs at launch, again at the tail
// of `nuke` (which just deleted it), and repairs a folder the user has
// deleted by hand. A data dir that has never been used starts with the
// fresh-install settings.
import { existsSync } from "node:fs";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateProjectConfigsToDirLayout } from "./projects/stateMigration";
import { tempPathFor, withSchemaVersion } from "./util/jsonFile";
import { CONFIG_FILE, dataDir, holdsState, STATE_FILE } from "./util/paths";

// The placeholders carry the schema marker like every other write, so
// even a data dir nobody has used yet says which shape it was made for.
const SEED_JSON = seedJson({});

// The settings a fresh install starts with, beyond the defaults every
// install shares. doubutsuNames reads as off when unset, so installs
// from before it defaulted on keep their adjective-animal names. A new
// install gets it written out instead. The CLI seeds the same document
// (cli/state.go freshConfigSeed). Keep the two in sync.
export const FRESH_CONFIG_SEED = { doubutsuNames: true } as const;

function seedJson(doc: object): string {
  return `${JSON.stringify(withSchemaVersion(doc), null, 2)}\n`;
}

// Race-safe "create if missing": the contents go to a temp file that is
// then linked into place, and link fails if the file exists. A CLI
// command reading it at the same moment sees no file or the whole
// thing, never one created but not yet written. On a filesystem without
// hard links (exFAT, some network shares) it creates the file in place
// instead, the one case where a reader could catch it empty.
async function ensureFile(path: string, contents: string): Promise<void> {
  if (existsSync(path)) return;
  const tmp = tempPathFor(path);
  try {
    await writeFile(tmp, contents, "utf8");
    await link(tmp, path).catch((error: unknown) => {
      if (isEEXIST(error)) return;
      return writeFile(path, contents, { flag: "wx", encoding: "utf8" });
    });
  } catch (error) {
    if (!isEEXIST(error)) throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

function isEEXIST(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

// registry.json is deliberately not seeded here. Its existence is what
// tells the store that the registry has already been moved out of
// state.json (config/store.ts), so conjuring an empty one would let a
// data dir whose state.json has gone unreadable read back as "no projects"
// instead of failing. It appears on the first registry write, or on the
// split, whichever comes first.
//
// "Never used" is holdsState's answer, taken before anything is
// written, not whether the folder exists: registry.json, state.json and
// config.json hold everything an install has (its projects, its state,
// its settings), and this bootstrap writes the last two on the first
// launch, so an existing install always has at least one. The folder
// itself proves nothing either way: a pointer or a SHIGOMORI_DATA_DIR
// can aim at an empty folder made in advance. The CLI makes the same
// check at the top of every command, on a data dir that exists
// (cli/state.go seedFreshInstall), so whichever runs first seeds and
// the other finds an install, and the create-if-missing write never
// replaces a config the CLI wrote first. Once config.json exists the
// probe answers true, so the seed happens once. A nuke empties the data dir, so the reseed
// after it starts fresh too.
export async function ensureDataDir(dir: string = dataDir()): Promise<void> {
  const fresh = holdsState(dir) === false;
  await mkdir(join(dir, "projects"), { recursive: true });
  await Promise.all([
    ensureFile(
      join(dir, CONFIG_FILE),
      fresh ? seedJson(FRESH_CONFIG_SEED) : SEED_JSON,
    ),
    ensureFile(join(dir, STATE_FILE), SEED_JSON),
    dir === dataDir() ? migrateProjectConfigsToDirLayout() : undefined,
  ]);
}
