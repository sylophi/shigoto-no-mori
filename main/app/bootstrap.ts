// Initialize ~/shigomori[-dev]/ on launch so the directory is browsable
// before the user has done anything. Idempotent: re-runs after `nuke` or
// when the user has deleted the folder by hand.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateProjectConfigsToDirLayout } from "../projects/stateMigration";
import { shigomoriRoot } from "../util/paths";

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
