// The doctor's v2-files check, which deletes the files a 2.x data dir
// kept once the import is verified, against a hand-seeded data dir so
// the real ~/.sm is never read.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Doctor from "../src/Doctor.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const run = (options: { readonly fix?: boolean } = {}) =>
  box.engine(
    Effect.flatMap(Effect.service(Doctor.Doctor), (doctor) =>
      doctor.run({
        version: "dev",
        executable: "",
        terminal: false,
        ...(options.fix === true
          ? {
              fix: {
                approve: () => Effect.succeed(true),
                failed: () => Effect.void,
              },
            }
          : {}),
      }),
    ),
  ) as Promise<Doctor.DoctorDocument>;

const findingsFor = (doc: Doctor.DoctorDocument, id: string) =>
  doc.checks.filter((finding) => finding.id === id);

// The one finding with the id, which must have the status.
const only = (
  doc: Doctor.DoctorDocument,
  id: string,
  status: Doctor.Status,
): Doctor.Finding => {
  const found = findingsFor(doc, id);
  assert.equal(found.length, 1, `${id}: ${JSON.stringify(doc.checks)}`);
  const [finding] = found;
  assert.ok(finding);
  assert.equal(finding.status, status, finding.detail);
  return finding;
};

it("reports the v2 files an unverified import left, and its fix leaves them", async () => {
  // A key the import skips: it can't verify the import, so the files
  // hold what the store doesn't.
  box.write("registry.json", { projects: [], unshelvedAt: { a: "x" } });
  const found = only(await run({ fix: true }), "v2-files", "warn");
  assert.match(found.detail, /may not hold/);
  assert.equal(found.repairable, undefined);
  assert.ok(existsSync(join(box.side("engine"), "registry.json")));
});

it("offers to delete a v2 file left as the import verified it, and leaves one written since to the person", async () => {
  box.write("registry.json", { projects: [] });
  box.write("config.json", { portPool: true });
  assert.deepEqual(findingsFor(await run(), "v2-files"), []);
  const side = box.side("engine");
  // A deletion that failed leaves the registry as it was verified; a
  // v2 build started since writes a config of its own.
  writeFileSync(join(side, "registry.json"), JSON.stringify({ projects: [] }));
  writeFileSync(join(side, "config.json"), JSON.stringify({ portPool: false }));
  const found = findingsFor(await run(), "v2-files");
  assert.equal(found.length, 2);
  const fixed = await run({ fix: true });
  assert.deepEqual(fixed.repaired, ["deleted 1 v2 file"]);
  assert.ok(!existsSync(join(side, "registry.json")));
  assert.ok(existsSync(join(side, "config.json")));
  assert.match(
    only(fixed, "v2-files", "warn").detail,
    /config\.json left from v2, which the store may not hold/,
  );
});
