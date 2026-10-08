import assert from "node:assert/strict";
import { it } from "vitest";
import { packageScripts } from "../src/packageJson.ts";

it("lists string scripts in manifest order, duplicates and all", () => {
  assert.deepEqual(
    packageScripts(`{
      "name": "x", "scripts": {"dev": "vite", "2": "two", "obj": {"a": "}"},
      "q\\"uote": "a \\"b\\" {", "dev": "again", "n": 1, "arr": ["]"]}
    }`),
    [
      { name: "dev", command: "vite" },
      { name: "2", command: "two" },
      { name: 'q"uote', command: 'a "b" {' },
      { name: "dev", command: "again" },
    ],
  );
});

it("takes the last scripts block, and none from a non-object one", () => {
  assert.deepEqual(
    packageScripts('{"scripts":{"a":"1"},"scripts":{"b":"2"}}'),
    [{ name: "b", command: "2" }],
  );
  assert.deepEqual(packageScripts('{"scripts":["a"]}'), []);
  assert.deepEqual(packageScripts('{"name":"x"}'), []);
  assert.deepEqual(packageScripts("null"), []);
});

it("refuses text that isn't a JSON object", () => {
  assert.throws(() => packageScripts("{"));
  assert.throws(() => packageScripts("[]"));
});
