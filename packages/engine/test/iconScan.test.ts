import assert from "node:assert/strict";
import { it } from "vitest";
import {
  iconHref,
  joinRelative,
  mimeOf,
  packageRoots,
} from "../src/iconScan.ts";

it("reads an icon link from a tag or a route's links object", () => {
  assert.equal(
    iconHref(
      '<link rel="stylesheet" href="/a.css"><LINK REL="icon" href="/i.svg?v=1">',
    ),
    "/i.svg",
  );
  assert.equal(
    iconHref('links: () => [{ rel: "shortcut icon", href: "/fav.ico" }]'),
    "/fav.ico",
  );
  assert.equal(
    iconHref('<link rel="apple-touch-icon" href="/a.png">'),
    undefined,
  );
});

it("orders package roots by depth, then name, the root first", () => {
  assert.deepEqual(
    packageRoots([
      "package.json",
      "b/c/package.json",
      "b/package.json",
      "a/package.json",
      "x.ts",
    ]),
    ["", "a", "b", "b/c"],
  );
});

it("joins and cleans relative paths as Go's path.Join", () => {
  assert.equal(joinRelative("", "public", "./img//a.svg"), "public/img/a.svg");
  assert.equal(joinRelative("web", "../x"), "x");
  assert.equal(joinRelative("", "../x"), "../x");
});

it("types an icon by its extension", () => {
  assert.equal(mimeOf("/a/b.svg"), "image/svg+xml");
  assert.equal(mimeOf("/a.b/c"), "application/octet-stream");
});
