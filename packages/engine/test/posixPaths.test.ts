// A path typed on macOS or Linux names the folder it named before the
// helpers learned Windows' spelling, `//x` read as `/x` as the OS reads it.
import assert from "node:assert/strict";
import {
  cleanPath,
  expandHome,
  samePath,
  tildify,
} from "@shigomori/contracts/projectPaths";
import { afterAll, beforeAll, it } from "vitest";
import { canonicalPath, isAnchoredHere } from "../src/canonicalPath.ts";

const { platform } = process;
beforeAll(() => Object.defineProperty(process, "platform", { value: "linux" }));
afterAll(() => Object.defineProperty(process, "platform", { value: platform }));

const home = "/home/me";

// What was typed, and the folder it named before.
it.each([
  ["/tmp/work/../other", "/tmp/other"],
  ["//tmp/work/../other", "/tmp/other"],
  ["///tmp/x/", "/tmp/x"],
  ["//server/share/..", "/server"],
  ["/a//b/./c/", "/a/b/c"],
  ["//", "/"],
  ["~/dev//x/..", "/home/me/dev"],
])("%s names %s", (typed, folder) => {
  assert.equal(cleanPath(expandHome(home, canonicalPath(typed))), folder);
});

it("tells folders apart by case, and reads a leading // as /", () => {
  assert.equal(samePath(canonicalPath("//tmp/X"), "/tmp/x"), false);
  assert.equal(samePath(canonicalPath("//tmp/x"), "/tmp/x"), true);
  assert.equal(tildify(canonicalPath("//home/me/x"), home), "~/x");
});

it("reads a drive as relative, as the OS does", () => {
  assert.equal(isAnchoredHere("C:/scratch"), false);
  assert.equal(isAnchoredHere("//server/share"), true);
  assert.equal(isAnchoredHere("~/wt"), true);
});
