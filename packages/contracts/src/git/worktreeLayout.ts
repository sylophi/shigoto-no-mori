// The renderer's mirror of the engine's worktreeBase, which decides
// where a worktree actually lands. Dependency-free, for either side.

import type { RuntimeInfo, WorktreeLayout } from "../schemas/index.ts";
import { PROJECT_CONFIG_DEFAULTS } from "../schemas/projectConfigDefaults.ts";

// Also appended to the primary's `.git/info/exclude`.
const IN_PROJECT_ROOT_DIR = ".shigomori";
const IN_PROJECT_SUBDIR = `${IN_PROJECT_ROOT_DIR}/wt`;

// The whole subtree, as destructive flows guarding against it want.
// The engine's isManagedPath uses parent equality instead.
export function isSameOrInside(path: string, ancestor: string): boolean {
  const folded = path.replace(/\/+$/, "");
  const base = ancestor.replace(/\/+$/, "");
  return folded === base || folded.startsWith(`${base}/`);
}

function joinPath(base: string, ...segments: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const seg of segments) {
    const parts = seg.split(/\/+/).filter((p) => p.length > 0);
    for (const part of parts) out += "/" + part;
  }
  return out;
}

// None for the mount point itself.
export function externalVolumeRoot(path: string): string | undefined {
  return /^(\/Volumes\/[^/]+)\/+[^/]/.exec(path)?.[1];
}

export interface DeviceLayoutInputs extends Pick<
  RuntimeInfo,
  "dataDir" | "canonicalDataDirName"
> {
  onProjectDrive: boolean;
}

// Null on the internal drive, or when the data dir already sits on the
// project's drive. Mirrors the engine's projectDriveBase.
export function projectDriveBaseFor(
  projectPath: string,
  {
    dataDir,
    canonicalDataDirName,
  }: Pick<DeviceLayoutInputs, "dataDir" | "canonicalDataDirName">,
): string | null {
  const volume = externalVolumeRoot(projectPath);
  if (volume === undefined || dataDir.startsWith(`${volume}/`)) return null;
  return joinPath(volume, canonicalDataDirName, "wt", lastSegment(projectPath));
}

export function managedDriveBaseFor(
  projectPath: string,
  device: DeviceLayoutInputs,
): string | null {
  return device.onProjectDrive
    ? projectDriveBaseFor(projectPath, device)
    : null;
}

function lastSegment(path: string): string {
  return path.split("/").findLast((s) => s.length > 0) ?? "";
}

interface LayoutInputs extends DeviceLayoutInputs {
  layout: WorktreeLayout;
  projectPath: string;
  customPath: string | null;
}

// A trailing space in a custom path is noise, never another folder.
export function layoutInputsFor(
  config: {
    worktreeLayout?: WorktreeLayout;
    customWorktreePath?: string | null;
  } | null,
  projectPath: string,
  { dataDir, canonicalDataDirName, onProjectDrive }: DeviceLayoutInputs,
): LayoutInputs {
  return {
    layout: config?.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout,
    projectPath,
    dataDir,
    canonicalDataDirName,
    onProjectDrive,
    customPath: config?.customWorktreePath?.trim() || null,
  };
}

export function worktreeBaseFor(inputs: LayoutInputs): string {
  const { layout, projectPath, dataDir, customPath } = inputs;
  if (layout === "in-project") {
    return joinPath(projectPath, IN_PROJECT_SUBDIR);
  }
  if (layout === "custom") {
    const trimmed = customPath?.trim();
    if (trimmed) {
      const stripped = trimmed.replace(/\/+$/, "");
      // A bare root: an empty string would join as relative and
      // prefix-match everything.
      if (!stripped) return trimmed;
      return stripped;
    }
  }
  if (layout === "managed-root") {
    const driveBase = managedDriveBaseFor(projectPath, inputs);
    if (driveBase !== null) return driveBase;
  }
  return joinPath(dataDir, "wt", lastSegment(projectPath));
}

export function worktreePathFor(
  inputs: LayoutInputs,
  worktreeName: string,
): string {
  return joinPath(worktreeBaseFor(inputs), worktreeName);
}
