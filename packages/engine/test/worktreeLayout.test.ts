import assert from "node:assert/strict";
import { join } from "node:path";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import { describe, it } from "vitest";
import {
  cleanPath,
  externalVolumeRoot,
  isSameOrInside,
  isManagedPath,
  managedBases,
  projectDriveBase,
  worktreeBase,
} from "../src/worktreeLayout.ts";
import { holds, textOf } from "./lib/properties.ts";

const external = "/Volumes/Ext/code/repo";
const driveBase = "/Volumes/Ext/.sm/wt/repo";
const place = (dataDir: string) => ({ dataDir, dataDirName: ".sm" });

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
  const managedRoot = "/Users/me/.sm/wt/repo";
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
    `${external}/.shigomori/wt`,
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
  assert.equal(
    worktreeBase(external, { ...on, worktreeLayout: "fromNewerBuild" }, at),
    managedRoot,
  );
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
  const bases = ["/", "/Users/me/.sm/wt/repo/"];
  assert.ok(isManagedPath("/Users/me/.sm/wt/repo/otter/", bases));
  assert.ok(!isManagedPath("/Users/me/.sm/wt/repo/otter/deep", bases));
  assert.ok(!isManagedPath("relative", bases));
});

// --- properties ---

// A folder name, and paths of a few of them, trailing slashes and
// doubled ones included.
const folder = textOf(["a", "b", "repo", "My Drive", "x-1", "é", "."], {
  minLength: 1,
  maxLength: 3,
}).pipe(Arbitrary.filter((text) => text !== "." && text !== ".."));
const folders = Arbitrary.array(folder, { minLength: 1, maxLength: 4 });
const sloppy = Arbitrary.map(
  Arbitrary.all([folders, Arbitrary.schema(Schema.Literals(["", "/", "//"]))]),
  ([parts, tail]) => `/${parts.join("/")}${tail}`,
);

// A project and a data dir on the boot drive or an external one.
const drive = Arbitrary.schema(Schema.Literals(["/Users/me", "/Volumes/Ext"]));
const where = Arbitrary.all({
  project: Arbitrary.map(Arbitrary.all([drive, folders]), ([root, parts]) =>
    join(root, ...parts),
  ),
  dataDir: Arbitrary.map(drive, (root) => join(root, ".sm")),
  settings: Arbitrary.all({
    worktreeLayout: Arbitrary.schema(
      Schema.Literals(["managed-root", "in-project", "custom", "someday"]),
    ),
    customWorktreePath: Arbitrary.schema(
      Schema.Literals(["", "  ", "/Users/me/wt", "/Volumes/Ext/wt/"]),
    ),
    managedOnProjectDrive: Arbitrary.schema(Schema.Boolean),
  }),
});

describe("layout properties", () => {
  it("cleans a path once and for all", () =>
    holds(sloppy, (path) => {
      const clean = cleanPath(path);
      return (
        cleanPath(clean) === clean && (clean === "/" || !clean.endsWith("/"))
      );
    }));

  it("counts a path inside a root only below it, not beside it", () =>
    holds(Arbitrary.all([sloppy, folders]), ([root, below]) => {
      const base = cleanPath(root);
      return (
        isSameOrInside(root, base) &&
        isSameOrInside(join(base, ...below), root) &&
        !isSameOrInside(`${base}x`, root)
      );
    }));

  it("puts every new worktree where it counts as managed", () =>
    holds(
      Arbitrary.all([where, folder]),
      ([{ project, dataDir, settings }, name]) => {
        const at = { dataDir, dataDirName: ".sm" };
        const base = worktreeBase(project, settings, at);
        return isManagedPath(
          join(base, name),
          managedBases(project, settings, at),
        );
      },
    ));
});
