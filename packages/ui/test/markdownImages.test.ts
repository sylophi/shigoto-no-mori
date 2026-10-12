// What a description's markdown may load (src/primitives/markdown.tsx):
// every URL an attribute names, each candidate of a srcset included,
// from GitHub or a host its caller registered.
import assert from "node:assert/strict";
import { GITHUB_IMAGE_HOSTS } from "@shigomori/contracts/predicates/imageHosts";
import { it } from "vitest";
import { loadsFrom } from "../src/primitives/markdown.tsx";

const hosts = [...GITHUB_IMAGE_HOSTS, "git.uni.example"];

it("loads from a registered remote's host and GitHub, and not from an unknown one", () => {
  assert.equal(
    loadsFrom("src", "https://media.git.uni.example/a.png", hosts),
    true,
  );
  assert.equal(loadsFrom("src", "https://tracker.example/p.gif", hosts), false);
  assert.equal(loadsFrom("src", "//tracker.example/p.gif", hosts), false);
  // A local name the caller shows an image of its own for.
  assert.equal(loadsFrom("src", "./shot.png", hosts), true);
  assert.equal(
    loadsFrom(
      "srcset",
      "https://github.com/a.png 1x, https://tracker.example/b.png 2x",
      hosts,
    ),
    false,
  );
  assert.equal(
    loadsFrom(
      "srcset",
      "https://github.com/a.png 1x, https://git.uni.example/b.png 2x",
      hosts,
    ),
    true,
  );
});
