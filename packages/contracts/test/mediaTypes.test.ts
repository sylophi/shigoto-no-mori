// The media a path names (src/mediaTypes.ts), which the files page and
// the diffs draw: by the name's extension, any case.
import assert from "node:assert/strict";
import { it } from "vitest";
import { mediaTypeOf } from "../src/mediaTypes.ts";

it("goes by the name's extension", () => {
  assert.equal(mediaTypeOf("data/textures/board.PNG"), "image/png");
  assert.equal(mediaTypeOf("clip.mov"), "video/mp4");
  assert.equal(mediaTypeOf("icon.svg"), undefined);
  assert.equal(mediaTypeOf(".png"), undefined);
  assert.equal(mediaTypeOf("dir.png/readme"), undefined);
});
