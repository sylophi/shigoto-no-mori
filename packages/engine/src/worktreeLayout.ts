// Where a project's worktrees live, as path math: the managed root
// under the data dir, the in-project folder, a custom base, and the
// project's own external drive. Worktree ids are a hash of the path, an
// on-disk format fixed for good.
import { createHash } from "node:crypto";
import { basename, join } from "node:path";

export const worktreeIdFromPath = (path: string) =>
  createHash("sha256").update(path).digest("hex").slice(0, 12);

// The settings the layout reads: the project's and the device's.
export type LayoutSettings = {
  readonly worktreeLayout?:
    | "managed-root"
    | "in-project"
    | "custom"
    | undefined;
  readonly customWorktreePath?: string | undefined;
  readonly managedOnProjectDrive: boolean;
};

// Where the data dir is, and the flavor's name for it, which a managed
// root on another drive is named after.
export type DataDirPlace = {
  readonly dataDir: string;
  readonly dataDirName: string;
};

// The external drive a path sits on: /Volumes/<name> for anything below
// a mounted volume (every drive but the boot one, on macOS), none for
// the mount point itself.
export function externalVolumeRoot(path: string): string | undefined {
  const mounts = "/Volumes/";
  if (!path.startsWith(mounts)) return undefined;
  const rest = path.slice(mounts.length);
  const cut = rest.indexOf("/");
  if (cut <= 0 || rest.slice(cut).replaceAll("/", "") === "") return undefined;
  return mounts + rest.slice(0, cut);
}

// The managed root's place on the project's own external drive. Always
// managed, so worktrees placed there stay ours whatever happens to the
// setting or the data dir later.
export function driveBaseOf(
  projectPath: string,
  place: DataDirPlace,
): string | undefined {
  const volume = externalVolumeRoot(projectPath);
  return volume === undefined
    ? undefined
    : join(volume, place.dataDirName, "worktrees", basename(projectPath));
}

// driveBaseOf as a destination for new worktrees: none as well when the
// data dir sits on the project's drive, where the managed root already is.
export function projectDriveBase(
  projectPath: string,
  place: DataDirPlace,
): string | undefined {
  const volume = externalVolumeRoot(projectPath);
  if (volume !== undefined && place.dataDir.startsWith(`${volume}/`)) {
    return undefined;
  }
  return driveBaseOf(projectPath, place);
}

const trimTrailingSlashes = (path: string) => path.replace(/\/+$/, "");

// Every base whose direct children count as managed for a project, all
// layouts included, so switching layouts doesn't turn worktrees external.
export function managedBases(
  projectPath: string,
  settings: Pick<LayoutSettings, "customWorktreePath">,
  place: DataDirPlace,
): ReadonlyArray<string> {
  const drive = driveBaseOf(projectPath, place);
  const custom = settings.customWorktreePath?.trim() ?? "";
  return [
    join(place.dataDir, "worktrees", basename(projectPath)),
    join(projectPath, ".shigomori", "worktrees"),
    ...(drive === undefined ? [] : [drive]),
    ...(custom === "" ? [] : [trimTrailingSlashes(custom)]),
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
// managed root under the data dir; the device's managedOnProjectDrive
// setting moves the managed-root layout onto the project's external
// drive.
export function worktreeBase(
  projectPath: string,
  settings: LayoutSettings,
  place: DataDirPlace,
): string {
  const managedRoot = join(place.dataDir, "worktrees", basename(projectPath));
  switch (settings.worktreeLayout ?? "managed-root") {
    case "in-project":
      return join(projectPath, ".shigomori", "worktrees");
    case "custom": {
      const custom = settings.customWorktreePath?.trim() ?? "";
      return custom === "" ? managedRoot : trimTrailingSlashes(custom);
    }
    case "managed-root": {
      const drive = projectDriveBase(projectPath, place);
      return drive !== undefined && settings.managedOnProjectDrive
        ? drive
        : managedRoot;
    }
  }
}
