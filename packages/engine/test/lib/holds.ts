// What a test makes refuse what it needs refused, by the means each OS
// has: a mode on macOS and Linux, entries denying everyone in the ACL on
// Windows, whose modes deny the owner nothing. Each answers its release.
import { execFileSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";

const deny = (at: string, ...rights: ReadonlyArray<string>) => {
  for (const right of rights) {
    execFileSync("icacls", [at, "/deny", `*S-1-1-0:${right}`]);
  }
  return () => {
    execFileSync("icacls", [at, "/remove:d", "*S-1-1-0"]);
  };
};

const chmod = (at: string, mode: number) => {
  const was = statSync(at).mode & 0o777;
  chmodSync(at, mode);
  return () => chmodSync(at, was);
};

// `file` unreadable.
export const unreadable = (file: string): (() => void) =>
  process.platform === "win32" ? deny(file, "(R)") : chmod(file, 0o000);

// Nothing added to `folder`, nor renamed or removed from it. Its files
// still read and write. Windows lets a file's own right to be deleted
// stand in for its folder's, so the files' is denied too.
export const readOnly = (folder: string): (() => void) =>
  process.platform === "win32"
    ? deny(folder, "(WD,AD,DC)", "(OI)(CI)(IO)(DE)")
    : chmod(folder, 0o555);

// `folder`'s entries can't be listed, though a path through it still
// leads.
export const unlistable = (folder: string): (() => void) =>
  process.platform === "win32" ? deny(folder, "(RD)") : chmod(folder, 0o311);
