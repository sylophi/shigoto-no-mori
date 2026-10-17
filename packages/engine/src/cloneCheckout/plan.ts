// The clone's pure phases: what it decides from what it has already read.
import { dirname, join } from "node:path";
import { type LstatEntry, S_IFDIR, S_IFMT } from "../Darwin.ts";
import {
  ancestors,
  checkedOutPerm,
  type IndexStat,
  indexStatOf,
  isAscii,
  matchesMode,
  olderThan,
  ordinaryIndexFlags,
  sameFile,
  type SourceEntry,
  type TreeEntry,
  verifiedRecord,
} from "../gitIndex.ts";
import { KEPT_FLAGS, maxOf, nanos } from "./documents.ts";

// Names a case-insensitive disk takes for one are left to git, which
// writes them in index order as a checkout does. APFS also folds
// Unicode normalization, so names outside ASCII go to git too.
export const caseCollisions = (targets: ReadonlyArray<TreeEntry>) => {
  const spelling = new Map<string, string>();
  const colliding = new Set<string>();
  const claim = (name: string, as: string) => {
    const key = name.toLowerCase();
    const previous = spelling.get(key);
    if (previous === undefined) spelling.set(key, as);
    else if (previous !== as) colliding.add(key);
    return previous !== undefined && previous === as;
  };
  for (const target of targets) {
    claim(target.path, target.path);
    for (const dir of ancestors(target.path)) {
      if (claim(dir, `${dir}/`)) break;
    }
  }
  return (p: string) => {
    if (colliding.size === 0) return false;
    if (colliding.has(p.toLowerCase())) return true;
    for (const dir of ancestors(p)) {
      if (colliding.has(dir.toLowerCase())) return true;
    }
    return false;
  };
};

// What the source's index says can be cloned. The files themselves
// are checked against it once cloned.
export const clonablePaths = ({
  targets,
  bySourcePath,
  blobSize,
  converted,
  symlinks,
  collides,
  indexSec,
  indexNsec,
}: {
  readonly targets: ReadonlyArray<TreeEntry>;
  readonly bySourcePath: ReadonlyMap<string, SourceEntry>;
  readonly blobSize: ReadonlyMap<string, number>;
  readonly converted: ReadonlySet<string>;
  readonly symlinks: boolean;
  readonly collides: (p: string) => boolean;
  readonly indexSec: number;
  readonly indexNsec: number;
}) => {
  const clonable = new Set<string>();
  for (const target of targets) {
    const entry = bySourcePath.get(target.path);
    // The blob's size too: the conversions left (CRLF to LF on the way
    // in) only ever shrink a file, so a file its blob's size holds the
    // blob's bytes.
    const size = blobSize.get(target.oid);
    if (
      entry === undefined ||
      !ordinaryIndexFlags(entry.flags) ||
      target.mode === 0o160000 ||
      (target.mode === 0o120000 && !symlinks) ||
      entry.mode !== target.mode ||
      entry.oid !== target.oid ||
      converted.has(target.path) ||
      !isAscii(target.path) ||
      collides(target.path) ||
      size === undefined ||
      entry.stat.size !== size ||
      !olderThan(entry.stat.mtimeSec, entry.stat.mtimeNsec, indexSec, indexNsec)
    ) {
      continue;
    }
    clonable.add(target.path);
  }
  return clonable;
};

// A directory is cloned whole when everything in it on the source side
// is a file being cloned. Each other path marks its folders as needing
// a walk. Each cloned path's unit is its outermost folder that can go
// whole, else the file itself; the parents are the folders the units
// are cloned into.
export const planUnits = ({
  targets,
  sourceEntries,
  others,
  clonable,
}: {
  readonly targets: ReadonlyArray<TreeEntry>;
  readonly sourceEntries: ReadonlyArray<SourceEntry>;
  readonly others: ReadonlyArray<string>;
  readonly clonable: ReadonlySet<string>;
}) => {
  const impure = new Set<string>();
  const markParents = (p: string) => {
    for (const dir of ancestors(p)) {
      if (impure.has(dir)) return;
      impure.add(dir);
    }
  };
  for (const other of others) {
    if (other !== "") markParents(other);
  }
  for (const entry of sourceEntries) {
    if (!clonable.has(entry.path)) markParents(entry.path);
  }
  const targetDirs = new Set<string>();
  const tracked = new Set<string>();
  for (const target of targets) {
    tracked.add(target.path);
    if (!clonable.has(target.path)) markParents(target.path);
    for (const dir of ancestors(target.path)) {
      if (targetDirs.has(dir)) break;
      targetDirs.add(dir);
    }
  }

  const units = new Set<string>();
  const parents = new Set<string>();
  for (const p of clonable) {
    let unit = p;
    for (let i = 0; i < p.length; i++) {
      if (p[i] === "/" && !impure.has(p.slice(0, i))) {
        unit = p.slice(0, i);
        break;
      }
    }
    if (!units.has(unit)) {
      units.add(unit);
      const parent = dirname(unit);
      if (parent !== ".") parents.add(parent);
    }
  }
  return { units: [...units].toSorted(), parents, targetDirs, tracked };
};

// Where the attributes outside the tree live, and the config files that
// decide which one is the global one.
export type AttributeFiles = {
  readonly globalAttrs: string;
  readonly infoAttrs: string;
  readonly configFiles: ReadonlyArray<string>;
};

const attributesOf = (source: string, dir: string) =>
  join(source, dir, ".gitattributes");

// When the attributes that apply to a path last changed, as far as
// ctimes can tell: each attributes file's and its folder's (a deleted
// .gitattributes shows there), for a path every folder above it. A
// source file git last checked after all of them was checked under the
// attributes in force now. One checked before may hold bytes a dropped
// conversion made, so its clone is read back and hashed once: the
// verified record keeps the proof while the file stays as it is.
//
// The cloned paths' folders, sorted, and the files to lstat for them.
export const attributeLooks = (
  source: string,
  clonable: Iterable<string>,
  { globalAttrs, infoAttrs, configFiles }: AttributeFiles,
) => {
  const folders = new Set<string>();
  for (const p of clonable) {
    for (const dir of ancestors(p)) {
      if (folders.has(dir)) break;
      folders.add(dir);
    }
  }
  const sortedFolders = [...folders].toSorted();
  const looked = [
    globalAttrs,
    infoAttrs,
    attributesOf(source, "."),
    ...sortedFolders.map((dir) => attributesOf(source, dir)),
  ];
  const toLstat = [
    ...new Set([
      ...looked,
      ...looked.map((file) => dirname(file)),
      ...configFiles,
      ...configFiles.map((file) => dirname(file)),
      ...sortedFolders.map((dir) => join(source, dir)),
    ]),
  ];
  return { folders: sortedFolders, toLstat };
};

// From the lstats attributeLooks asked for: when each folder's
// attributes last changed, which folders are real ones, and the newest
// attributes change seen.
export const attributeCutoffs = (
  source: string,
  folders: ReadonlyArray<string>,
  { globalAttrs, infoAttrs, configFiles }: AttributeFiles,
  stats: ReadonlyMap<string, LstatEntry>,
) => {
  let newest = 0n;
  const ctimeOf = (file: string) => {
    const st = stats.get(file);
    if (st === undefined) return 0n;
    const at = nanos(st.ctimeSec, st.ctimeNsec);
    if (at > newest) newest = at;
    return at;
  };
  const fileAndFolder = (file: string) =>
    file === "" ? 0n : maxOf(ctimeOf(file), ctimeOf(dirname(file)));
  // A config file's own ctime, or its folder's when it's gone. Left out
  // of `newest`: the folders include the home folder, which changes all
  // the time, and a file stale for no reason only costs a read back.
  let configChanged = 0n;
  for (const file of configFiles) {
    const st = stats.get(file) ?? stats.get(dirname(file));
    if (st !== undefined) {
      configChanged = maxOf(configChanged, nanos(st.ctimeSec, st.ctimeNsec));
    }
  }
  const attrsChanged = new Map<string, bigint>([
    [
      ".",
      maxOf(
        configChanged,
        fileAndFolder(globalAttrs),
        fileAndFolder(infoAttrs),
        fileAndFolder(attributesOf(source, ".")),
      ),
    ],
  ]);
  // git doesn't look past a symlinked folder for a tracked path, and
  // neither does this: a source path is only taken when each folder
  // above it is a real one.
  const realDir = new Map<string, boolean>([[".", true]]);
  for (const dir of folders) {
    const st = stats.get(join(source, dir));
    realDir.set(
      dir,
      st !== undefined &&
        (st.mode & S_IFMT) === S_IFDIR &&
        realDir.get(dirname(dir)) === true,
    );
    attrsChanged.set(
      dir,
      maxOf(
        attrsChanged.get(dirname(dir)) ?? 0n,
        fileAndFolder(attributesOf(source, dir)),
      ),
    );
  }
  return { newest, attrsChanged, realDir };
};

// Files git last checked before the attributes changed, proven by
// hashing unless an earlier clone proved that very version. Strictly
// before: a change at the very instant the file last changed is that
// change.
export const stale = (
  p: string,
  bySourcePath: ReadonlyMap<string, SourceEntry>,
  attrsChanged: ReadonlyMap<string, bigint>,
) => {
  const st = bySourcePath.get(p)?.stat;
  return (
    st !== undefined &&
    nanos(st.ctimeSec, st.ctimeNsec) < (attrsChanged.get(dirname(p)) ?? 0n)
  );
};

// A stale clone to read back, with the record that proves it.
type ToHash = {
  readonly p: string;
  readonly entry: SourceEntry;
  readonly stat: IndexStat;
  readonly record: string;
};

// Each clone is kept only if the source file still has the stat its
// index entry recorded when git last hashed it (a write moves ctime
// forward for good), and carries nothing a checkout wouldn't give it:
// the permissions git creates files with, no file flags or extended
// attributes. Anything else goes to git.
export const verdicts = ({
  clonable,
  bySourcePath,
  sourceStats,
  cloneStats,
  sourceXattrs,
  realDir,
  mask,
  attrsChanged,
  verified,
}: {
  readonly clonable: ReadonlyArray<string>;
  readonly bySourcePath: ReadonlyMap<string, SourceEntry>;
  readonly sourceStats: ReadonlyMap<string, LstatEntry>;
  readonly cloneStats: ReadonlyMap<string, LstatEntry>;
  readonly sourceXattrs: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly realDir: ReadonlyMap<string, boolean>;
  readonly mask: number;
  readonly attrsChanged: ReadonlyMap<string, bigint>;
  readonly verified: ReadonlyMap<string, string>;
}) => {
  const kept = new Map<string, IndexStat>();
  const rejected: string[] = [];
  const toHash: ToHash[] = [];
  for (const p of clonable) {
    const raw = sourceStats.get(p);
    const entry = bySourcePath.get(p);
    const names = sourceXattrs.get(p);
    const st = cloneStats.get(p);
    if (
      entry === undefined ||
      raw === undefined ||
      st === undefined ||
      names === undefined
    ) {
      rejected.push(p);
      continue;
    }
    const after = indexStatOf(raw);
    const cloneStat = indexStatOf(st);
    if (
      realDir.get(dirname(p)) !== true ||
      !sameFile(after, entry.stat) ||
      !matchesMode(after, entry.mode) ||
      !checkedOutPerm(after, entry.mode, mask) ||
      (raw.flags & ~KEPT_FLAGS) !== 0 ||
      names.some((name) => name !== "com.apple.provenance") ||
      // clonefile keeps the mtime and mode: anything else isn't our
      // clone.
      cloneStat.mtimeSec !== after.mtimeSec ||
      cloneStat.mtimeNsec !== after.mtimeNsec ||
      cloneStat.size !== after.size ||
      cloneStat.mode !== after.mode
    ) {
      rejected.push(p);
      continue;
    }
    const record = verifiedRecord(entry.oid, entry.stat);
    if (stale(p, bySourcePath, attrsChanged) && verified.get(p) !== record) {
      toHash.push({ p, entry, stat: cloneStat, record });
    } else {
      kept.set(p, cloneStat);
    }
  }
  return { kept, rejected, toHash };
};
