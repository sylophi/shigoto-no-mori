// One-shot migration from the flat-file project config layout
// (<dataDir>/projects/<id>.json) to the per-project directory layout
// (projects/<id>/project.json + projects/<id>/worktrees/<wId>.json).
//
// Runs on every app start. Idempotent: a project that's already been
// migrated has no <id>.json file to act on, so the scan walks past it.
// Crash-safety: we write the new layout first, then unlink the old file.
// A crash mid-migration leaves both layouts on disk; the next launch
// picks up where it left off, and the new files (atomically written) win.
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  atomicWriteJson,
  unlinkIfExists,
  withSchemaVersion,
} from "../util/jsonFile";
import { isENOENT, dataDir } from "../util/paths";

// A loose mirror of the legacy ShigomoriConfig: we only need to recognize
// the fields we're moving. Anything else is preserved by pass-through.
interface LegacyConfig {
  notes?: Record<string, string>;
  [key: string]: unknown;
}

const LEGACY_EXT = ".json";

function projectsDir(): string {
  return join(dataDir(), "projects");
}

async function migrateOne(projectId: string): Promise<void> {
  const oldFile = join(projectsDir(), `${projectId}${LEGACY_EXT}`);
  const newProjectFile = join(projectsDir(), projectId, "project.json");
  const newWorktreesDir = join(projectsDir(), projectId, "worktrees");

  let raw: string;
  try {
    raw = await readFile(oldFile, "utf8");
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }

  let parsed: LegacyConfig;
  try {
    parsed = JSON.parse(raw) as LegacyConfig;
  } catch (err) {
    console.warn(
      `[shigomori] couldn't parse legacy ${oldFile}; leaving in place:`,
      err,
    );
    return;
  }

  const { notes, ...projectFields } = parsed;
  await atomicWriteJson(newProjectFile, withSchemaVersion(projectFields));

  if (notes && typeof notes === "object") {
    // `allSettled` so one bad note doesn't strand the rest of the project's
    // state mid-migration. Failures get logged and the legacy file is kept
    // (we skip the unlink below), so a future launch can retry.
    const writes: Promise<void>[] = [];
    for (const [worktreeId, text] of Object.entries(notes)) {
      if (typeof text !== "string" || text.length === 0) continue;
      writes.push(
        atomicWriteJson(
          join(newWorktreesDir, `${worktreeId}.json`),
          withSchemaVersion({ notes: text }),
        ),
      );
    }
    const results = await Promise.allSettled(writes);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      for (const f of failures) {
        console.warn(`[shigomori] migration note write failed:`, f.reason);
      }
      return;
    }
  }

  await unlinkIfExists(oldFile);
}

export async function migrateProjectConfigsToDirLayout(): Promise<void> {
  let entries;
  try {
    entries = await readdir(projectsDir(), { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }

  const legacyIds: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(LEGACY_EXT)) {
      legacyIds.push(basename(e.name, LEGACY_EXT));
    }
  }

  await Promise.all(legacyIds.map(migrateOne));
}
