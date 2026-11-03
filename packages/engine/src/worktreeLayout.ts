// The engine's side of the worktree layout: worktree ids, the staging
// folders beside worktrees, and which folders count as managed. Where
// new worktrees go is contracts' worktreeBase.
import {
  type DataDirPlace,
  driveBaseOf,
  inProjectBaseOf,
  managedRootOf,
} from "@shigomori/contracts/git/worktreeLayout";
import { createHash } from "node:crypto";

// A worktree's id: a hash of its path, an on-disk format fixed for good
// (marks and the per-worktree files are keyed by it).
export const worktreeIdFromPath = (path: string) =>
  createHash("sha256").update(path).digest("hex").slice(0, 12);

// The managed root under the data dir, the in-project folder, and the
// drive's when the project is on one.
const ownBases = (projectPath: string, place: DataDirPlace) => {
  const drive = driveBaseOf(projectPath, place);
  return [
    managedRootOf(projectPath, place),
    inProjectBaseOf(projectPath),
    ...(drive === undefined ? [] : [drive]),
  ];
};

// A folder made beside a worktree while it is built, hidden and named
// after it: a move's copy across volumes (`partial`), a create's
// carry-over (`carry`).
export const stagingName = (
  worktree: string,
  kind: "partial" | "carry",
  tag: string,
) => `.${worktree}.${kind}-${tag}`;

// Whether a name beside the worktrees is one of those, which the doctor
// doesn't count as a stray worktree.
export const isStagingName = (name: string) =>
  /^\..+\.(partial|carry)-[\w-]+$/.test(name);

// How many levels from a worktree's parent up are ours, removed once a
// last worktree leaves them empty: the project's folder under the
// managed root, the in-project folder and `.shigomori`, or the drive's
// project folder, root and data dir. Zero for any other parent.
export const ownedLevels = (
  parent: string,
  projectPath: string,
  place: DataDirPlace,
) => ownBases(projectPath, place).indexOf(parent) + 1;

const trimTrailingSlashes = (path: string) => path.replace(/\/+$/, "");

// Every base whose direct children count as managed for a project, all
// layouts included, so switching layouts doesn't turn worktrees external.
// `customBase` is the project's, as contracts' customBaseOf gives it.
export const managedBases = (
  projectPath: string,
  place: DataDirPlace,
  customBase: string | undefined,
): ReadonlyArray<string> => [
  ...ownBases(projectPath, place),
  ...(customBase === undefined ? [] : [customBase]),
];

// Parent equality, not a prefix: a root base would otherwise claim every
// worktree on the volume.
export function isManagedPath(
  worktreePath: string,
  bases: ReadonlyArray<string>,
): boolean {
  const folded = trimTrailingSlashes(worktreePath);
  const cut = folded.lastIndexOf("/");
  if (cut < 0) return false;
  const parent = folded.slice(0, cut);
  return bases.some((base) => trimTrailingSlashes(base) === parent);
}
