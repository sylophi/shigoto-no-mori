// Durable proof for the look at whether a path's drive is connected
// (shared/unmountedVolume.ts): a data folder on a drive that isn't
// connected is said at the start, before a host is forked to make the
// folder there, and a mirror rooted there waits for the drive.
// Asserts that a path on a volume not mounted names that volume, at
// its mount point and below it and through a link (a dangling one),
// and that a path on a mounted volume is fine, a folder whose parents
// don't exist yet among them.
//
// Run: pnpm test unmounted-volume.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, it } from "vitest";
import { unmountedVolume } from "../shared/unmountedVolume.ts";
import { makeTracker, tempDir } from "./lib/checkKit.mts";

const { track, teardown } = makeTracker();
afterAll(teardown);
const GONE = "/Volumes/sm-proof-not-mounted";

it("a path on a volume not mounted names it, through links too; one on a mounted volume is fine", () => {
  const home = tempDir("sm-volume-", track);
  assert.equal(unmountedVolume(GONE), GONE);
  assert.equal(unmountedVolume(join(GONE, "work", ".sm")), GONE);
  const link = join(home, "data-link");
  symlinkSync(join(GONE, ".sm"), link);
  assert.equal(unmountedVolume(link), GONE);
  const linkedParent = join(home, "drive");
  symlinkSync(GONE, linkedParent);
  assert.equal(unmountedVolume(join(linkedParent, "nested", ".sm")), GONE);

  // A relative link whose `..` is read from the link's target, not
  // folded away before it: drive/../.sm is the drive's .sm.
  const nested = join(home, "nested-drive");
  symlinkSync(join(GONE, "nested"), nested);
  const relative = join(home, "relative-link");
  symlinkSync("nested-drive/../.sm", relative);
  assert.equal(unmountedVolume(relative), GONE);
  // A `..` past the missing mount point doesn't step back out of it.
  const pastIt = join(home, "past-link");
  symlinkSync(`${GONE}/../../tmp/.sm`, pastIt);
  assert.equal(unmountedVolume(pastIt), GONE);
  // Links that go round end without an answer rather than for good.
  symlinkSync("loop-b", join(home, "loop-a"));
  symlinkSync("loop-a", join(home, "loop-b"));
  assert.equal(unmountedVolume(join(home, "loop-a", ".sm")), null);

  assert.equal(unmountedVolume(join(home, "new", "nested", ".sm")), null);
  mkdirSync(join(home, "here"));
  assert.equal(unmountedVolume(join(home, "here")), null);
  assert.equal(unmountedVolume("/Volumes"), null);
});
