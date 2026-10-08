// git's index, as the clone checkout reads and writes it: the records
// `ls-tree` and `ls-files --debug` print, the stat data an entry pins a
// file to, which attributes make a checkout convert, and the version 2
// index file itself.

import { S_IFLNK, S_IFMT, S_IFREG } from "./Darwin.ts";

// The stat data an index entry records, each field truncated to the 32
// bits the index stores, as git does.
export type IndexStat = {
  readonly ctimeSec: number;
  readonly ctimeNsec: number;
  readonly mtimeSec: number;
  readonly mtimeNsec: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
};

const NO_STAT: IndexStat = {
  ctimeSec: 0,
  ctimeNsec: 0,
  mtimeSec: 0,
  mtimeNsec: 0,
  dev: 0,
  ino: 0,
  mode: 0,
  uid: 0,
  gid: 0,
  size: 0,
};

const u32 = (value: number) => Number(BigInt.asUintN(32, BigInt(value)));

// What lstat says, as the index would record it.
export const indexStatOf = (st: {
  readonly ctimeSec: number;
  readonly ctimeNsec: number;
  readonly mtimeSec: number;
  readonly mtimeNsec: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
}): IndexStat => ({
  ctimeSec: u32(st.ctimeSec),
  ctimeNsec: u32(st.ctimeNsec),
  mtimeSec: u32(st.mtimeSec),
  mtimeNsec: u32(st.mtimeNsec),
  dev: u32(st.dev),
  ino: u32(st.ino),
  mode: u32(st.mode),
  uid: u32(st.uid),
  gid: u32(st.gid),
  size: u32(st.size),
});

// The fields git compares to decide a file is unchanged (the default
// core.checkStat), but the mode, which matchesMode covers.
export const sameFile = (a: IndexStat, b: IndexStat) =>
  a.ctimeSec === b.ctimeSec &&
  a.ctimeNsec === b.ctimeNsec &&
  a.mtimeSec === b.mtimeSec &&
  a.mtimeNsec === b.mtimeNsec &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.gid === b.gid &&
  a.size === b.size;

// Whether a file of this stat is what an entry of this mode describes: a
// symlink for 120000, a regular file with the owner's exec bit to match
// otherwise.
export const matchesMode = (st: IndexStat, mode: number) => {
  switch (mode) {
    case 0o120000:
      return (st.mode & S_IFMT) === S_IFLNK;
    case 0o100755:
      return (st.mode & S_IFMT) === S_IFREG && (st.mode & 0o100) !== 0;
    case 0o100644:
      return (st.mode & S_IFMT) === S_IFREG && (st.mode & 0o100) === 0;
  }
  return false;
};

// The permissions git gives a file it writes, under this umask: what a
// source file has to carry for its clone to pass as checked out.
export const checkedOutPerm = (st: IndexStat, mode: number, umask: number) => {
  switch (mode) {
    case 0o100644:
      return (st.mode & 0o7777) === (0o666 & ~umask);
    case 0o100755:
      return (st.mode & 0o7777) === (0o777 & ~umask);
  }
  // A symlink's own bits mean nothing.
  return true;
};

export const olderThan = (
  sec: number,
  nsec: number,
  thanSec: number,
  thanNsec: number,
) => sec < thanSec || (sec === thanSec && nsec < thanNsec);

// A path's folders, nearest first, up to (not including) the root.
export function* ancestors(path: string): Generator<string> {
  let dir = path.replace(/\/$/, "");
  for (;;) {
    const cut = dir.lastIndexOf("/");
    if (cut < 0) return;
    dir = dir.slice(0, cut);
    yield dir;
  }
}

export type TreeEntry = {
  readonly mode: number;
  readonly oid: string;
  readonly path: string;
};

export type SourceEntry = TreeEntry & {
  readonly stage: number;
  readonly flags: string;
  readonly stat: IndexStat;
};

// `git ls-tree -r -z`: "<mode> <type> <oid>\t<path>" records.
export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const fields = tab < 0 ? [] : record.slice(0, tab).trim().split(/\s+/);
    if (tab < 0 || fields.length !== 3) {
      throw new Error(`unexpected ls-tree record ${JSON.stringify(record)}`);
    }
    entries.push({
      mode: Number.parseInt(fields[0] ?? "", 8),
      oid: fields[2] ?? "",
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

// `git ls-files -s -z --debug`: each "<mode> <oid> <stage>\t<path>\0"
// header followed by five newline-terminated stat lines.
export function parseLsFilesDebug(out: string): SourceEntry[] {
  const entries: SourceEntry[] = [];
  let rest = out;
  while (rest !== "") {
    const nul = rest.indexOf("\0");
    if (nul < 0) {
      throw new Error(`unterminated ls-files record ${JSON.stringify(rest)}`);
    }
    const header = rest.slice(0, nul);
    let after = rest.slice(nul + 1);
    const tab = header.indexOf("\t");
    const fields = tab < 0 ? [] : header.slice(0, tab).trim().split(/\s+/);
    if (tab < 0 || fields.length !== 3) {
      throw new Error(`unexpected ls-files record ${JSON.stringify(header)}`);
    }
    const path = header.slice(tab + 1);
    const values = new Map<string, string>();
    for (let line = 0; line < 5; line++) {
      const newline = after.indexOf("\n");
      if (newline < 0) {
        throw new Error(`short stat block for ${JSON.stringify(path)}`);
      }
      for (const field of after.slice(0, newline).trim().split("\t")) {
        const cut = field.indexOf(": ");
        if (cut >= 0) values.set(field.slice(0, cut), field.slice(cut + 2));
      }
      after = after.slice(newline + 1);
    }
    const number = (text: string | undefined) => {
      if (text === undefined || !/^\d+$/.test(text)) {
        throw new Error(
          `bad stat value ${JSON.stringify(text)} for ${JSON.stringify(path)}`,
        );
      }
      return Number(text);
    };
    const pair = (text: string | undefined) => {
      const [a, b] = (text ?? "").split(":");
      return [number(a), number(b)] as const;
    };
    const [ctimeSec, ctimeNsec] = pair(values.get("ctime"));
    const [mtimeSec, mtimeNsec] = pair(values.get("mtime"));
    entries.push({
      mode: Number.parseInt(fields[0] ?? "", 8),
      oid: fields[1] ?? "",
      stage: number(fields[2]),
      path,
      flags: values.get("flags") ?? "",
      stat: {
        ctimeSec,
        ctimeNsec,
        mtimeSec,
        mtimeNsec,
        dev: number(values.get("dev")),
        ino: number(values.get("ino")),
        mode: 0,
        uid: number(values.get("uid")),
        gid: number(values.get("gid")),
        size: number(values.get("size")),
      },
    });
    rest = after;
  }
  return entries;
}

// ls-files --debug prints an entry's in-memory flags in hex. A conflict
// stage, assume-unchanged, intent-to-add or skip-worktree means the
// entry isn't a plain record of a file on disk. The other bits
// (fsmonitor's mark, name hashing) say nothing about the file.
export const ordinaryIndexFlags = (flags: string) => {
  if (!/^[0-9a-fA-F]+$/.test(flags)) return false;
  const stage = 0x3000n;
  const assumeValid = 0x8000n;
  const intentToAdd = 1n << 29n;
  const skipWorktree = 1n << 30n;
  return (
    (BigInt(`0x${flags}`) &
      (stage | assumeValid | intentToAdd | skipWorktree)) ===
    0n
  );
};

export const isAscii = (text: string) => {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) return false;
  }
  return true;
};

// The attributes that can make a checkout write anything but the blob.
export const CONVERSION_ATTRS = [
  "filter",
  "ident",
  "working-tree-encoding",
  "text",
  "eol",
  "crlf",
] as const;

// The config a checkout's conversions read.
export type CheckoutConfig = {
  // "true", "input" or "false".
  readonly autocrlf: string;
  // "crlf", "lf", "native" or empty.
  readonly eol: string;
  readonly symlinks: boolean;
};

// Paths whose checkout runs through something other than copying the
// blob out: a filter (LFS), ident, a working-tree encoding, or line
// endings turned to CRLF (eol=crlf, or text with core.autocrlf=true or
// core.eol=crlf). From `check-attr -z`: path, attribute, value triples.
export function checkoutConverts(
  attrOut: string,
  config: CheckoutConfig,
): Set<string> {
  const fields = attrOut.split("\0");
  const converted = new Set<string>();
  const crlfByDefault = config.autocrlf === "true" || config.eol === "crlf";
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i] ?? "";
    const attr = fields[i + 1];
    const value = fields[i + 2];
    const specified = value !== "unspecified" && value !== "unset";
    switch (attr) {
      case "filter":
      case "ident":
      case "working-tree-encoding":
        if (specified) converted.add(path);
        break;
      case "crlf":
        // Set, unset (-crlf, binary) or "input": any says text or not.
        if (value !== "unspecified") converted.add(path);
        break;
      case "eol":
        if (value === "crlf") converted.add(path);
        break;
      case "text":
        if (crlfByDefault && value !== "unset") converted.add(path);
        break;
    }
  }
  return converted;
}

// The record for an index entry a clone proved: its blob and the stat
// that pins the file to it.
export const verifiedRecord = (oid: string, st: IndexStat) =>
  `${oid} ${st.ctimeSec}.${st.ctimeNsec} ${st.mtimeSec}.${st.mtimeNsec} ${st.dev} ${st.ino} ${st.size}`;

const encoder = new TextEncoder();

// The bytes git hashes as a blob: its header, then the content.
export const blobBytes = (content: Uint8Array): Uint8Array => {
  const header = encoder.encode(`blob ${content.length}\0`);
  const all = new Uint8Array(header.length + content.length);
  all.set(header);
  all.set(content, header.length);
  return all;
};

const hexBytes = (hex: string): Uint8Array | undefined => {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
};

export const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

// A version 2 index without extensions (git adds what it wants on its
// next write), each path with its stat (zeroes for none, which git reads
// as changed until checkout-index fills them in), its trailing checksum
// left to the caller. `oidBytes` is the object format's hash size.
export function indexBody(
  entries: ReadonlyArray<TreeEntry>,
  stats: ReadonlyMap<string, IndexStat>,
  oidBytes: number,
): Uint8Array {
  // By the bytes of their paths, as git sorts them.
  const named = entries.map((entry) => ({
    entry,
    name: encoder.encode(entry.path),
  }));
  named.sort((a, b) => compareBytes(a.name, b.name));
  const sorted = named.map(({ entry }) => entry);
  const chunks: Uint8Array[] = [];
  const header = new DataView(new ArrayBuffer(12));
  header.setUint32(0, 0x44495243); // "DIRC"
  header.setUint32(4, 2);
  header.setUint32(8, sorted.length);
  chunks.push(new Uint8Array(header.buffer));
  for (const entry of sorted) {
    const st = stats.get(entry.path) ?? NO_STAT;
    const oid = hexBytes(entry.oid);
    if (oid === undefined || oid.length !== oidBytes) {
      throw new Error(`bad object id ${entry.oid} for ${entry.path}`);
    }
    const name = encoder.encode(entry.path);
    const fixed = 40 + oid.length + 2 + name.length;
    // NUL-padded to a multiple of eight, with at least one NUL.
    const record = new Uint8Array(fixed + (8 - (fixed % 8)));
    const view = new DataView(record.buffer);
    [
      st.ctimeSec,
      st.ctimeNsec,
      st.mtimeSec,
      st.mtimeNsec,
      st.dev,
      st.ino,
      entry.mode,
      st.uid,
      st.gid,
      st.size,
    ].forEach((value, index) => view.setUint32(index * 4, value));
    record.set(oid, 40);
    view.setUint16(40 + oid.length, Math.min(name.length, 0xfff));
    record.set(name, 40 + oid.length + 2);
    chunks.push(record);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return body;
}
