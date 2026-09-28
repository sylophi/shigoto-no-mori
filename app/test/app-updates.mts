// Durable proof for which devices the update toast and Settings' Update
// all act on (renderer/lib/updates.ts).
//
// Asserts: app versions order the way the CLI's semver does
// (cli/semver.go), prereleases below their release and an unparseable
// version unknown. The newest release any device found, staged or
// downloading, is the one the rest are measured against: a device
// running an older build counts as behind before its own check finds
// it, while one already on it, one whose build is unknown, one that
// doesn't update itself, and one not yet read don't. A staged update
// counts whatever its version, and so does a download an older build
// doesn't name.
//
// Runs under test/lib/register-ts-alias.mts so the app's TypeScript
// imports resolve. Run: pnpm test app-updates.
import assert from "node:assert/strict";
import { compareAppVersions } from "@shared/releases";
import type { UpdaterState } from "@shared/schemas";
import { type DeviceUpdater, findOutdated } from "@/lib/updates";
import { makeProof } from "./lib/checkKit.mts";

const { check, done, fail } = makeProof("app updates proof");
console.log("app updates proof\n");

const ready = (version: string): UpdaterState => ({
  kind: "ready",
  version,
  releaseDate: null,
});
const idle: UpdaterState = { kind: "idle" };

function device(
  deviceId: string,
  running: string,
  state: UpdaterState | undefined,
): DeviceUpdater {
  return { deviceId, running, state };
}

async function main(): Promise<void> {
  await check("versions order like the CLI's semver", () => {
    const cases: [string, string, number | null][] = [
      ["2.0.3", "2.1.0", -1],
      ["2.1.0", "2.1.0", 0],
      ["2.10.0", "2.9.9", 1],
      ["v2.1.0", "2.1.0", 0],
      ["2.1.0+build.5", "2.1.0", 0],
      ["2.1.0-beta.1", "2.1.0", -1],
      ["2.1.0-beta.2", "2.1.0-beta.10", -1],
      ["2.1.0-beta", "2.1.0-beta.1", -1],
      ["2.1.0-alpha", "2.1.0-beta", -1],
      ["2.1.0-1", "2.1.0-alpha", -1],
      ["", "2.1.0", null],
      ["1.02.0", "1.2.0", null],
      ["2.1", "2.1.0", null],
      ["2.1.0-01", "2.1.0", null],
      ["2.1.0-a..b", "2.1.0", null],
    ];
    for (const [a, b, want] of cases) {
      assert.equal(compareAppVersions(a, b), want, `${a} vs ${b}`);
    }
  });

  await check("nothing found: nobody is behind", () => {
    assert.deepEqual(
      findOutdated([device("a", "2.0.3", idle), device("b", "2.0.3", idle)]),
      { latest: null, oldest: null, outdated: {} },
    );
  });

  await check("one device's find puts the older ones behind", () => {
    const { latest, oldest, outdated } = findOutdated([
      device("local", "2.0.3", idle),
      device("found", "2.0.3", { kind: "downloading", version: "2.1.0" }),
      device("current", "2.1.0", idle),
      device("unknown", "", idle),
      device("dev", "0.0.0", { kind: "unsupported" }),
      device("unread", "2.0.3", undefined),
      device("checking", "2.0.3", { kind: "checking" }),
      device("failed", "2.0.3", { kind: "error", message: "offline" }),
    ]);
    assert.equal(latest, "2.1.0");
    assert.equal(oldest, "2.0.3");
    assert.deepEqual(outdated, {
      local: { staged: false },
      found: { staged: false },
      checking: { staged: false },
      failed: { staged: false },
    });
  });

  await check("the newest find wins, and a staged update counts", () => {
    const { latest, oldest, outdated } = findOutdated([
      device("between", "2.0.4", idle),
      device("old", "2.0.3", ready("2.0.4")),
      device("new", "2.0.3", ready("2.1.0")),
      device("nameless", "2.0.3", { kind: "downloading" }),
    ]);
    assert.equal(latest, "2.1.0");
    // The furthest behind, whichever came first.
    assert.equal(oldest, "2.0.3");
    assert.deepEqual(outdated, {
      old: { staged: true },
      new: { staged: true },
      between: { staged: false },
      nameless: { staged: false },
    });
  });

  await check("a prerelease puts only the beta ride behind", () => {
    const { outdated } = findOutdated([
      device("beta", "2.1.0-beta.1", ready("2.1.0-beta.2")),
      device("older-beta", "2.1.0-beta.1", idle),
      device("stable", "2.0.3", idle),
    ]);
    assert.deepEqual(outdated, {
      beta: { staged: true },
      "older-beta": { staged: false },
    });
  });

  await check("a nameless download alone names no release", () => {
    assert.deepEqual(
      findOutdated([
        device("nameless", "2.0.3", { kind: "downloading" }),
        device("other", "2.0.3", idle),
      ]),
      {
        latest: null,
        oldest: "2.0.3",
        outdated: {
          nameless: { staged: false },
        },
      },
    );
  });

  done();
}

main().catch(fail);
