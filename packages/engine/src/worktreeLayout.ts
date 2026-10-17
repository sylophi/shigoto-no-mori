// Where a project's worktrees live, as path math: the managed root
// under the data dir, the in-project folder, a custom base, and the
// project's own external drive.
import { PROJECT_CONFIG_DEFAULTS } from "@shigomori/contracts/schemas/projectConfigDefaults";
import { createHash } from "node:crypto";
import { basename, join, normalize } from "node:path";
import { externalVolumeRoot } from "@shigomori/contracts/git/worktreeLayout";

// A worktree's id: a hash of its path, an on-disk format fixed for good
// (marks and the per-worktree files are keyed by it).
export const worktreeIdFromPath = (path: string) =>
  createHash("sha256").update(path).digest("hex").slice(0, 12);

// The settings the layout reads: the project's and the device's.
export type LayoutSettings = {
  // A name this build doesn't know reads as the plain managed root.
  readonly worktreeLayout?: string | undefined;
  readonly customWorktreePath?: string | undefined;
  readonly managedOnProjectDrive: boolean;
};

// The folder worktrees live in under each root: short, since agents and
// people read and type these paths all day.
const WT = "wt";

// Where the data dir is, and the flavor's name for it, which a managed
// root on another drive is named after.
export type DataDirPlace = {
  readonly dataDir: string;
  readonly dataDirName: string;
  // The data dir with its links resolved, where the caller read it.
  readonly realDataDir?: string | undefined;
};

// The managed root's place on the project's own external drive. Always
// managed, so worktrees placed there stay ours whatever happens to the
// setting or the data dir later.
function driveBaseOf(
  projectPath: string,
  place: DataDirPlace,
): string | undefined {
  const volume = externalVolumeRoot(projectPath);
  return volume === undefined
    ? undefined
    : join(volume, place.dataDirName, WT, basename(projectPath));
}

// driveBaseOf as a destination for new worktrees: none as well when the
// data dir sits on the project's drive, where the managed root already is.
export function projectDriveBase(
  projectPath: string,
  place: DataDirPlace,
): string | undefined {
  const volume = externalVolumeRoot(projectPath);
  if (
    volume !== undefined &&
    [place.dataDir, place.realDataDir].some((dir) =>
      dir?.startsWith(`${volume}/`),
    )
  ) {
    return undefined;
  }
  return driveBaseOf(projectPath, place);
}

// The managed root under the data dir, the in-project folder, and the
// drive's when the project is on one.
const ownBases = (projectPath: string, place: DataDirPlace) => {
  const drive = driveBaseOf(projectPath, place);
  return [
    join(place.dataDir, WT, basename(projectPath)),
    join(projectPath, ".shigomori", WT),
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

// A path as Go's filepath.Clean leaves it: normalized, and without a
// trailing slash except on the root.
export const cleanPath = (path: string) => {
  const normalized = normalize(path);
  return normalized === "/" ? normalized : trimTrailingSlashes(normalized);
};

// Every base whose direct children count as managed for a project, all
// layouts included, so switching layouts doesn't turn worktrees external.
export function managedBases(
  projectPath: string,
  settings: Pick<LayoutSettings, "customWorktreePath">,
  place: DataDirPlace,
): ReadonlyArray<string> {
  const custom = settings.customWorktreePath?.trim() ?? "";
  return [
    ...ownBases(projectPath, place),
    ...(custom === "" ? [] : [cleanPath(custom)]),
  ];
}

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

// Where new worktrees go. Custom without a path falls back to the
// managed root under the data dir, and the device's managedOnProjectDrive
// setting moves the managed-root layout onto the project's external
// drive.
export function worktreeBase(
  projectPath: string,
  settings: LayoutSettings,
  place: DataDirPlace,
): string {
  const managedRoot = join(place.dataDir, WT, basename(projectPath));
  switch (settings.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout) {
    case "in-project":
      return join(projectPath, ".shigomori", WT);
    case "custom": {
      // Cleaned, so a custom path of `/` stays the root rather than an
      // empty, relative base, and one through `..` is the folder it names.
      const custom = settings.customWorktreePath?.trim() ?? "";
      return custom === "" ? managedRoot : cleanPath(custom);
    }
    case "managed-root": {
      const drive = projectDriveBase(projectPath, place);
      return drive !== undefined && settings.managedOnProjectDrive
        ? drive
        : managedRoot;
    }
    default:
      return managedRoot;
  }
}
