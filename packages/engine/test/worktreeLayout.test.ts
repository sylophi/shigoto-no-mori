import assert from "node:assert/strict";
import { it } from "vitest";
import {
  externalVolumeRoot,
  isManagedPath,
  managedBases,
  projectDriveBase,
  worktreeBase,
  worktreeIdFromPath,
} from "../src/worktreeLayout.ts";

const external = "/Volumes/Ext/code/repo";
const driveBase = "/Volumes/Ext/.sm/worktrees/repo";
const place = (dataDir: string) => ({ dataDir, dataDirName: ".sm" });

it("hashes a path to the id the Go sm gives it", () => {
  assert.equal(worktreeIdFromPath("/Users/me/code/repo"), "af61e6e2212f");
});

it("finds the external drive a path sits on", () => {
  for (const [path, want] of [
    ["/Volumes/Ext/code/repo", "/Volumes/Ext"],
    ["/Volumes/My Drive/repo", "/Volumes/My Drive"],
    ["/Users/me/code/repo", undefined],
    ["/Volumes/Ext", undefined],
    ["/Volumes/Ext/", undefined],
    ["/Volumes", undefined],
    ["/Volumes//repo", undefined],
    ["/VolumesNot/Ext/repo", undefined],
  ] as const) {
    assert.equal(externalVolumeRoot(path), want, path);
  }
});

it("offers the project's drive unless the data dir is already on it", () => {
  assert.equal(projectDriveBase(external, place("/Users/me/.sm")), driveBase);
  assert.equal(
    projectDriveBase("/Users/me/code/repo", place("/Users/me/.sm")),
    undefined,
  );
  assert.equal(
    projectDriveBase(external, place("/Volumes/Ext/stash/.sm")),
    undefined,
  );
  assert.equal(
    projectDriveBase(external, place("/Volumes/Other/.sm")),
    driveBase,
  );
});

it("moves only the managed root onto the project's drive, and only when asked", () => {
  const at = place("/Users/me/.sm");
  const managedRoot = "/Users/me/.sm/worktrees/repo";
  const off = { managedOnProjectDrive: false };
  const on = { managedOnProjectDrive: true };
  assert.equal(worktreeBase(external, off, at), managedRoot);
  assert.equal(worktreeBase(external, on, at), driveBase);
  assert.equal(
    worktreeBase(external, { ...on, worktreeLayout: "managed-root" }, at),
    driveBase,
  );
  assert.equal(
    worktreeBase(external, { ...on, worktreeLayout: "in-project" }, at),
    `${external}/.shigomori/worktrees`,
  );
  assert.equal(
    worktreeBase(
      external,
      {
        ...on,
        worktreeLayout: "custom",
        customWorktreePath: "/Users/me/trees/",
      },
      at,
    ),
    "/Users/me/trees",
  );
  assert.equal(
    worktreeBase(
      external,
      { ...on, worktreeLayout: "custom", customWorktreePath: " " },
      at,
    ),
    managedRoot,
  );
  assert.equal(worktreeBase("/Users/me/code/repo", on, at), managedRoot);
});

it("counts the drive base as managed wherever the data dir is", () => {
  for (const dataDir of ["/Users/me/.sm", "/Volumes/Ext/stash/.sm"]) {
    const bases = managedBases(external, {}, place(dataDir));
    assert.ok(bases.includes(driveBase), dataDir);
    assert.ok(isManagedPath(`${driveBase}/otter`, bases), dataDir);
  }
  assert.equal(
    managedBases("/Users/me/code/repo", {}, place("/Users/me/.sm")).length,
    2,
  );
});

it("holds a worktree managed by its parent, not a prefix", () => {
  const bases = ["/", "/Users/me/.sm/worktrees/repo/"];
  assert.ok(isManagedPath("/Users/me/.sm/worktrees/repo/otter/", bases));
  assert.ok(!isManagedPath("/Users/me/.sm/worktrees/repo/otter/deep", bases));
  assert.ok(!isManagedPath("relative", bases));
});
