// The classification (README.md, "Classification"): what every call of
// every contract module may do over a wire, as its annotations say,
// held in fixtures/wire/classification.json. A flipped annotation, a
// call joining or leaving the remote surface, or a grant moving, fails
// here with the diff, for a reviewer to read as what the device link
// now hands to other devices.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import {
  annotation,
  Busy,
  callsOf,
  channelOf,
  type ContractModule,
  Gated,
  Grant,
  Invitable,
  isPush,
  isInvoke,
  Remote,
  scopeOf,
  TracksProjectUsage,
} from "../src/contract.ts";

const file = join(import.meta.dirname, "../fixtures/wire/classification.json");

// A call as the file holds it: its kind and its module's scope, then
// each annotation it carries. An annotation it lacks stays out, since
// the registrar fails closed on a missing one.
const classify = (module: ContractModule) =>
  callsOf(module).map((call): [string, Record<string, unknown>] => [
    channelOf(call),
    Object.fromEntries(
      Object.entries({
        kind: isInvoke(call) ? "invoke" : isPush(call) ? "push" : "view",
        scope: scopeOf(module),
        remote: annotation(call, Remote),
        gated: annotation(call, Gated),
        grant: annotation(call, Grant),
        invitable: annotation(call, Invitable),
        tracksProjectUsage: annotation(call, TracksProjectUsage),
        busy: annotation(call, Busy),
      }).filter(([, value]) => value !== undefined),
    ),
  ]);

// Every module, as the wire samples read them (wire.test.ts).
const modulesDir = join(import.meta.dirname, "../src/modules");
const modules = (await Promise.all(
  readdirSync(modulesDir).map((name) => import(join(modulesDir, name))),
)) as Record<string, unknown>[];
const derived = Object.fromEntries(
  modules
    .flatMap((module) =>
      Object.entries(module)
        .filter(([exported]) => exported.endsWith("Contract"))
        .flatMap(([, value]) => classify(value as ContractModule)),
    )
    .toSorted(([a], [b]) => a.localeCompare(b)),
);

// `pnpm -F @shigomori/contracts classification` writes the file from
// the contract, every call of it.
if (process.env["UPDATE_CLASSIFICATION"] === "1") {
  writeFileSync(file, `${JSON.stringify(derived, null, 2)}\n`);
}

it("every call is classified as fixtures/wire/classification.json holds", () => {
  assert.ok(existsSync(file), `${file} is missing`);
  assert.deepEqual(
    derived,
    JSON.parse(readFileSync(file, "utf8")),
    "the classification changed: if it is meant to, run pnpm -F @shigomori/contracts classification",
  );
});

// A quit waits only on the calls that change code (the host's
// `changing`), so a busy kind on any other would never be counted.
it("every call a quit waits on changes code", () => {
  for (const [channel, call] of Object.entries(derived)) {
    if (call["busy"] === undefined) continue;
    assert.equal(
      call["grant"],
      "changeCode",
      `${channel} has a busy kind but not the changeCode grant`,
    );
  }
});
