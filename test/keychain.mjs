// Drives the Safe Storage reset (main/keychain/reset.ts) under plain
// node: the owned-marker gate, the delete-then-mark order, the
// no-marker-on-failure retry rule, and Electron's item naming. On
// macOS it also runs the real deleter (main/keychain/security.ts)
// against a probe item created with an EMPTY trusted-application
// list, the worst case a foreign item can present: the deletion must
// land without a dialog (a dialog would hang until the deleter's own
// timeout fails the check), and a second deletion must report the
// item missing. The Electron wiring (main/electron/keychain.ts) and
// the mock-keychain switch in main/index.ts are human-verify items:
// only a Developer-ID-signed package exercises them.
//
// Node 22.18+ strips the .ts types on import, so no loader is needed:
// both modules import node builtins only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import {
  resetSafeStorageOnce,
  safeStorageItemNames,
} from "../main/keychain/reset.ts";
import { deleteGenericPassword } from "../main/keychain/security.ts";
import { makeChecker, report } from "./lib/checkKit.mjs";

const { check, failures } = makeChecker();

// An io stub over an in-memory marker and a scripted keychain:
// `items` copies of the item to delete one by one, or "throws" for a
// deleter that fails. `calls` records the order of every io call.
function fakeIo({ marker = false, items = 1 } = {}) {
  const calls = [];
  const io = {
    hasMarker: () => marker,
    writeMarker: () => {
      calls.push("write");
      marker = true;
    },
    deleteItem: () => {
      calls.push("delete");
      if (items === "throws") throw new Error("keychain locked");
      if (items === 0) return "missing";
      items -= 1;
      return "deleted";
    },
  };
  return { io, calls, marker: () => marker };
}

check("names the item the way Electron does", () => {
  assert.deepEqual(safeStorageItemNames("Shigoto no Mori"), {
    service: "Shigoto no Mori Safe Storage",
    account: "Shigoto no Mori Key",
  });
});

check("first launch deletes until missing, then writes the marker", () => {
  const { io, calls, marker } = fakeIo();
  assert.equal(resetSafeStorageOnce(io), "deleted");
  assert.deepEqual(
    calls,
    ["delete", "delete", "write"],
    "the marker follows the deletion that reported missing",
  );
  assert.equal(marker(), true);
});

check("a second copy on the search list goes too", () => {
  const { io, calls } = fakeIo({ items: 2 });
  assert.equal(resetSafeStorageOnce(io), "deleted");
  assert.deepEqual(calls, ["delete", "delete", "delete", "write"]);
});

check("a deleter that never reports missing is bounded", () => {
  const { io, calls } = fakeIo({ items: Infinity });
  assert.equal(resetSafeStorageOnce(io), "deleted");
  assert.ok(calls.length < 20, `unbounded: ${calls.length} calls`);
  assert.equal(calls.at(-1), "write");
});

check("a missing item still writes the marker", () => {
  const { io, calls } = fakeIo({ items: 0 });
  assert.equal(resetSafeStorageOnce(io), "missing");
  assert.deepEqual(calls, ["delete", "write"]);
});

check("an owned marker touches nothing", () => {
  const { io, calls } = fakeIo({ marker: true });
  assert.equal(resetSafeStorageOnce(io), "owned");
  assert.deepEqual(calls, []);
});

check(
  "a failed deletion throws and writes no marker, so the next launch retries",
  () => {
    const { io, calls, marker } = fakeIo({ items: "throws" });
    assert.throws(() => resetSafeStorageOnce(io), /keychain locked/);
    assert.deepEqual(calls, ["delete"]);
    assert.equal(marker(), false);
  },
);

if (platform() === "darwin") {
  // The probe item: a distinct name so a leak could never be mistaken
  // for the app's own, and `-T ""` for an empty trusted-application
  // list, so nothing (not even `security`) holds an ACL grant on it.
  const { service, account } = safeStorageItemNames(
    `Shigoto no Mori keychain check ${process.pid}`,
  );
  // No separate cleanup: the second check deletes whatever the first
  // left behind, and reports it loudly if that was more than nothing.
  check("deleting a foreign item lands without a dialog", () => {
    execFileSync(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
        "probe",
        "-T",
        "",
      ],
      { stdio: "ignore" },
    );
    const started = Date.now();
    assert.equal(deleteGenericPassword(service, account), "deleted");
    assert.ok(
      Date.now() - started < 5_000,
      "a deletion that waited on a dialog would not be this fast",
    );
  });
  check("deleting an absent item reports it missing", () => {
    assert.equal(deleteGenericPassword(service, account), "missing");
  });
}

report({
  name: "keychain reset",
  failures,
  hint: "The Safe Storage reset (main/keychain/) drifted from its contract: fix the module or the check.",
});
