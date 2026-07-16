// Initialize ~/shigomori[-dev]/ so the directory is browsable before the
// user has done anything. Idempotent: runs at launch, again at the tail
// of `nuke` (which just deleted it), and repairs a folder the user has
// deleted by hand.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateProjectConfigsToDirLayout } from "./projects/stateMigration";
import { shigomoriRoot } from "./util/paths";

const EMPTY_JSON = "{}\n";

async function ensureFile(path: string, contents: string): Promise<void> {
  try {
    // `wx` fails if the file exists — race-safe "create if missing".
    await writeFile(path, contents, { flag: "wx", encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
}

export async function ensureShigomoriRoot(): Promise<void> {
  const root = shigomoriRoot();
  await mkdir(join(root, "projects"), { recursive: true });
  await Promise.all([
    ensureFile(join(root, "config.json"), EMPTY_JSON),
    ensureFile(join(root, "state.json"), EMPTY_JSON),
    migrateProjectConfigsToDirLayout(),
  ]);
}
