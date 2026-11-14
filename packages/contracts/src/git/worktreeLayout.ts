// Where a project's new worktrees go, as path math: the managed root
// under the data dir, the in-project folder, a custom base, and the
// project's own external drive. The engine places worktrees by it and
// the renderer previews them by it, so it is posix strings only.

import {
  cleanPath,
  expandHome,
  joinPath,
  lastSegment,
  relativeInside,
} from "../projectPaths.ts";
import { PROJECT_CONFIG_DEFAULTS } from "../schemas/projectConfigDefaults.ts";

// The folder worktrees live in under each root: short, since agents and
// people read and type these paths all day.
export const WORKTREES_DIR = "wt";

// None for the mount point itself, and for a Windows path, whose
// worktrees stay where the setting's other choices put them.
export function externalVolumeRoot(path: string): string | undefined {
  return /^(\/Volumes\/[^/]+)\/+[^/]/.exec(path)?.[1];
}

// Where a device's data dir is, and the flavor's name for it, which a
// managed root on another drive is named after.
export type DataDirPlace = {
  readonly dataDir: string;
  // The data dir with its links resolved, where that was read.
  readonly dataDirReal?: string | undefined;
  readonly canonicalDataDirName: string;
};

// A device's side of the layout: its data dir, its home for a custom
// base under `~/`, and its managedOnProjectDrive setting.
export type DeviceLayout = DataDirPlace & {
  readonly homedir: string;
  readonly onProjectDrive: boolean;
};

export const managedRootOf = (projectPath: string, place: DataDirPlace) =>
  joinPath(place.dataDir, WORKTREES_DIR, lastSegment(projectPath));

export const inProjectBaseOf = (projectPath: string) =>
  joinPath(projectPath, ".shigomori", WORKTREES_DIR);

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
    : joinPath(
        volume,
        place.canonicalDataDirName,
        WORKTREES_DIR,
        lastSegment(projectPath),
      );
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
    [place.dataDir, place.dataDirReal].some(
      (dir) => dir !== undefined && relativeInside(dir, volume) !== undefined,
    )
  ) {
    return undefined;
  }
  return driveBaseOf(projectPath, place);
}

// projectDriveBase where the device's setting keeps managed worktrees
// there.
export const managedDriveBase = (projectPath: string, device: DeviceLayout) =>
  device.onProjectDrive ? projectDriveBase(projectPath, device) : undefined;

// A custom base, none when empty. One under `~/` is in this device's
// home, whichever device wrote it. Cleaned, so `/` stays the root rather
// than an empty, relative base, and one through `..` is the folder it
// names.
export function customBaseOf(
  customPath: string | null | undefined,
  homedir: string,
): string | undefined {
  const custom = customPath?.trim() ?? "";
  return custom === "" ? undefined : cleanPath(expandHome(homedir, custom));
}

export type LayoutInputs = DeviceLayout & {
  // A name this build doesn't know reads as the plain managed root.
  readonly layout?: string | undefined;
  readonly projectPath: string;
  readonly customPath?: string | null | undefined;
};

// Custom without a path falls back to the managed root under the data
// dir.
export function worktreeBase(inputs: LayoutInputs): string {
  const { projectPath } = inputs;
  switch (inputs.layout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout) {
    case "in-project":
      return inProjectBaseOf(projectPath);
    case "custom":
      return (
        customBaseOf(inputs.customPath, inputs.homedir) ??
        managedRootOf(projectPath, inputs)
      );
    case "managed-root":
      return (
        managedDriveBase(projectPath, inputs) ??
        managedRootOf(projectPath, inputs)
      );
    default:
      return managedRootOf(projectPath, inputs);
  }
}

export const worktreePathFor = (inputs: LayoutInputs, worktreeName: string) =>
  joinPath(worktreeBase(inputs), worktreeName);
