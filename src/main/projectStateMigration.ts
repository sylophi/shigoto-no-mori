// One-shot migration from the flat-file project config layout
// (~/shigomori[-dev]/projects/<id>.json) to the per-project directory layout
// (projects/<id>/project.json + projects/<id>/worktrees/<wId>.json).
//
// Runs on every app start. Idempotent: a project that's already been
// migrated has no <id>.json file to act on, so the scan walks past it.
// Crash-safety: we write the new layout first, then unlink the old file.
// A crash mid-migration leaves both layouts on disk; the next launch
// picks up where it left off, and the new files (atomically written) win.
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./jsonFile";
import { isENOENT, shigomoriRoot } from "./paths";

// A loose mirror of the legacy ShigomoriConfig: we only need to recognize
// the fields we're moving. Anything else is preserved by pass-through.
interface LegacyConfig {
  notes?: Record<string, string>;
  [key: string]: unknown;
}

function projectsDir(): string {
  return join(shigomoriRoot(), "projects");
}

async function migrateOne(projectId: string): Promise<void> {
  const oldFile = join(projectsDir(), `${projectId}.json`);
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
  await atomicWriteJson(newProjectFile, projectFields);

  if (notes && typeof notes === "object") {
    await Promise.all(
      Object.entries(notes)
        .filter(([, text]) => typeof text === "string" && text.length > 0)
        .map(([worktreeId, text]) =>
          atomicWriteJson(join(newWorktreesDir, `${worktreeId}.json`), {
            notes: text,
          }),
        ),
    );
  }

  await unlink(oldFile).catch((err) => {
    if (!isENOENT(err)) throw err;
  });
}

export async function migrateProjectConfigsToDirLayout(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(projectsDir());
  } catch (err) {
    if (isENOENT(err)) return;
    throw err;
  }

  const candidates = entries.filter((e) => e.endsWith(".json"));
  const stats = await Promise.all(
    candidates.map(async (entry) => {
      try {
        const s = await stat(join(projectsDir(), entry));
        return s.isFile() ? entry.slice(0, -".json".length) : null;
      } catch (err) {
        if (isENOENT(err)) return null;
        throw err;
      }
    }),
  );

  await Promise.all(stats.filter((id) => id !== null).map(migrateOne));
}
