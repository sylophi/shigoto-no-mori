// Pure path math for worktree layouts, for the renderer: the Worktree
// Location page's previews and the destinations it asks relocate for,
// the New Worktree form's destination label, the convert-external
// preview. A display-side mirror of resolveWorktreeBase in
// cli/paths.go, which decides where a worktree actually lands;
// test/cli-reads.mts pins the two against each other for every layout.
//
// Kept dependency-free so it can run in either environment.

import type { RuntimeInfo, WorktreeLayout } from "../schemas";
import { PROJECT_CONFIG_DEFAULTS } from "../schemas/projectConfigDefaults";

// Project-relative directory used by the "in-project" layout. Top-level
// component (`.shigomori`) is also the path appended to the primary's
// `.git/info/exclude` so it stays out of `git status`.
const IN_PROJECT_ROOT_DIR = ".shigomori";
const IN_PROJECT_SUBDIR = `${IN_PROJECT_ROOT_DIR}/worktrees`;

// Containment test: true when `path` IS `ancestor` or sits anywhere
// beneath it. Prefix matching by intent. Callers guarding destructive
// flows (nuke, data dir move) want the whole subtree. Contrast the
// CLI's isManagedPath (cli/paths.go), which deliberately uses parent
// equality instead.
export function isSameOrInside(path: string, ancestor: string): boolean {
  const folded = path.replace(/\/+$/, "");
  const base = ancestor.replace(/\/+$/, "");
  return folded === base || folded.startsWith(`${base}/`);
}

// Dependency-free join that works in both main and the renderer (no
// node:path).
function joinPath(base: string, ...segments: string[]): string {
  let out = base.replace(/\/+$/, "");
  for (const seg of segments) {
    const parts = seg.split(/\/+/).filter((p) => p.length > 0);
    for (const part of parts) out += "/" + part;
  }
  return out;
}

// The external drive a path sits on: /Volumes/<name> for anything below
// a mounted volume, null otherwise. Mirrors externalVolumeRoot in
// cli/paths.go.
function externalVolumeRoot(path: string): string | null {
  const match = /^(\/Volumes\/[^/]+)\/+[^/]/.exec(path);
  return match?.[1] ?? null;
}

// What the layouts need to know of the device: where its data dir is,
// the flavor's own name for it (".sm" / ".smd"), and whether its
// managedOnProjectDrive setting is on.
export interface DeviceLayoutInputs extends Pick<
  RuntimeInfo,
  "dataDir" | "canonicalDataDirName"
> {
  onProjectDrive: boolean;
}

// The managed root's shape on the project's own external drive, which
// the managed layout uses while the device's setting is on. Null when there is
// no such place: the project is on the internal drive, or the data dir
// sits on the project's drive and the managed root is on it already.
// Mirrors projectDriveBase in cli/paths.go.
export function projectDriveBaseFor(
  projectPath: string,
  {
    dataDir,
    canonicalDataDirName,
  }: Pick<DeviceLayoutInputs, "dataDir" | "canonicalDataDirName">,
): string | null {
  const volume = externalVolumeRoot(projectPath);
  if (volume === null || dataDir.startsWith(`${volume}/`)) return null;
  return joinPath(
    volume,
    canonicalDataDirName,
    "worktrees",
    lastSegment(projectPath),
  );
}

// Where the device keeps this project's managed worktrees when its
// managedOnProjectDrive setting moves them onto the project's drive.
// Null while the setting is off, or with no such drive.
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

// Directory new worktrees should live under for the given layout. Custom
// without a path falls back to the managed root rather than producing an
// invalid path; the UI prevents saving an empty custom path.
// The layout inputs a project's config resolves to, told once for the
// host and the renderer alike (a trailing space in a custom path is
// noise, never a different folder).
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
      // A bare root ("/") is nothing but separators; return it as-is
      // rather than an empty string that would later join as a relative
      // path and prefix-match everything.
      if (!stripped) return trimmed;
      return stripped;
    }
  }
  if (layout === "managed-root") {
    const driveBase = managedDriveBaseFor(projectPath, inputs);
    if (driveBase !== null) return driveBase;
  }
  return joinPath(dataDir, "worktrees", lastSegment(projectPath));
}

// Full destination path for a single worktree under the given layout.
export function worktreePathFor(
  inputs: LayoutInputs,
  worktreeName: string,
): string {
  return joinPath(worktreeBaseFor(inputs), worktreeName);
}
