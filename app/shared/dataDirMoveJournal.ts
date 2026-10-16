// The journal a data-folder move keeps in the data dir while it runs
// (host/lib/dataDirMove.ts), and the start that finds a move a crash cut
// between its rename and its pointer (initDataDir, shared/paths.ts).
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const JOURNAL = "data-dir-move.json";
export const Journal = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  // The sibling a copy to another volume fills, null for a rename.
  partial: Schema.NullOr(Schema.String),
  moved: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      oldPath: Schema.String,
      newPath: Schema.String,
    }),
  ),
});
export type Journal = typeof Journal.Type;
export const JournalJson = Schema.fromJsonString(Journal);

const journalAt = (dir: string) => {
  try {
    return Schema.decodeUnknownOption(JournalJson)(
      readFileSync(join(dir, JOURNAL), "utf8"),
    );
  } catch {
    return Option.none<Journal>();
  }
};

// A move whose folder landed but whose pointer never moved: the pointer
// (or its absence) still names `named`, the folder that left, and the
// move's journal sits at the destination, naming `named` as its source.
// A rename leaves no journal at `named` (a copy keeps the source and its
// journal, which the next start undoes instead). The destination is the
// pointer's staged copy's target, or the default location, which needs
// no pointer; the pointer is committed as the move would have, and the
// destination answered, for the host's resume to finish the rest.
export function rescueStrandedMove(input: {
  readonly named: string;
  readonly pointerFile: string;
  readonly legacyPointerFile: string | null;
  readonly defaultDataDir: string;
}): string | null {
  const { named, pointerFile, legacyPointerFile, defaultDataDir } = input;
  if (existsSync(join(named, JOURNAL))) return null;
  const staged = (() => {
    try {
      return readdirSync(dirname(pointerFile))
        .filter((entry) => entry.startsWith(`${basename(pointerFile)}.tmp.`))
        .map((entry) => join(dirname(pointerFile), entry));
    } catch {
      return [];
    }
  })();
  const candidates = [
    ...staged.map((file) => ({
      file,
      dir: readFileSync(file, "utf8").trim(),
    })),
    { file: null, dir: defaultDataDir },
  ];
  for (const { file, dir } of candidates) {
    if (dir === "" || resolve(dir) === resolve(named)) continue;
    const journal = journalAt(dir);
    if (
      Option.isNone(journal) ||
      resolve(journal.value.from) !== resolve(named) ||
      resolve(journal.value.to) !== resolve(dir)
    ) {
      continue;
    }
    if (file === null) {
      rmSync(pointerFile, { force: true });
    } else {
      renameSync(file, pointerFile);
    }
    if (legacyPointerFile !== null) rmSync(legacyPointerFile, { force: true });
    return dir;
  }
  return null;
}
