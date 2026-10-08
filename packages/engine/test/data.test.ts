// The data files the engine ships are the ones the Go sm embeds, until
// the switch-over deletes cli/.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

const read = (dir: string, file: string) =>
  JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;

it.each(["launcher-catalog.json", "name-words.json", "doubutsu-names.json"])(
  "%s matches cli/embed",
  (file) => {
    assert.deepEqual(
      read(join(import.meta.dirname, "..", "src", "data"), file),
      read(join(import.meta.dirname, "..", "..", "..", "cli", "embed"), file),
    );
  },
);
