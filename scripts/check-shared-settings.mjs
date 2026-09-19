// Durable proof for the shared settings (shared/sharedSettings.ts, the
// host copy in host/lib/sharedSettings/store.ts, the browser copy in
// web/ipc/register.ts). No server holds them, so everything rests on
// the merge: copies exchange entries in whatever order the network
// allows and must still agree.
//
// Asserts: merging is order-free and idempotent and hands back the
// same document when it learned nothing (the fact that ends an
// exchange), a write outranks what its copy has seen even from a
// device whose clock runs behind, a cleared setting stays cleared
// against a copy still holding the old value, an entry this build has
// never heard of is carried and forwarded while one it cannot hold is
// left out without costing the rest, a full copy refuses a new key out
// loud, the host copy persists in
// registry.json beside the keys the CLI owns and announces only real
// changes, the browser copy does the same off localStorage, and three
// copies that were never all online together converge through pairwise
// exchanges alone.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "sharedsettings:check".
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSharedSettingsCopy,
  EMPTY_SHARED_SETTINGS,
  exchangeSharedSettings,
  mergeSharedSettings,
  sharedSettingKeys,
  sharedSettingsAhead,
  sharedStringSetting,
  withSharedSetting,
} from "@shared/sharedSettings";
import {
  MAX_SHARED_SETTING_ENTRIES,
  SharedSettingsDocSchema,
} from "@shared/schemas/sharedSettings";
import { initDataDirAt } from "@host/lib/util/paths";
import {
  onSharedSettingsChange,
  sharedSettingsCopy,
} from "@host/lib/sharedSettings/store";
import { createWebBridge } from "../web/ipc/register.ts";
import { makeProof, memoryStorage } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("shared settings proof");

const KEY = sharedSettingKeys.quickCreateDevice("github.com/acme/widgets");
const KIWI = "00000000-0000-4000-8000-00000000000a";
const LYCHEE = "00000000-0000-4000-8000-00000000000b";

function webBridge() {
  return createWebBridge({
    localStorage: memoryStorage(),
    env: {},
    userAgent: "check",
    openExternal: () => {},
    isDev: true,
    appVersion: "0.0.0-check",
    fetchImpl: () => Promise.reject(new TypeError("fetch is not stubbed")),
  });
}

// The exchange the renderer runs on a session landing
// (renderer/lib/remote/sharedSettingsSync.ts), over two bridges.
const exchange = (mine, theirs) =>
  exchangeSharedSettings(mine.sharedSettings, theirs.sharedSettings);

async function main() {
  await check(
    "merge: order-free, idempotent, and the same document back when nothing was learned",
    () => {
      const a = withSharedSetting(EMPTY_SHARED_SETTINGS, KEY, KIWI, KIWI, 100);
      const b = withSharedSetting(
        EMPTY_SHARED_SETTINGS,
        KEY,
        LYCHEE,
        LYCHEE,
        200,
      );
      const c = withSharedSetting(
        EMPTY_SHARED_SETTINGS,
        "other",
        true,
        KIWI,
        50,
      );
      const abc = mergeSharedSettings(mergeSharedSettings(a, b), c);
      const cba = mergeSharedSettings(mergeSharedSettings(c, b), a);
      assert.deepEqual(abc, cba);
      assert.equal(sharedStringSetting(abc, KEY), LYCHEE);
      // Identity, not just equality: callers skip the write and the
      // announcement off it.
      assert.equal(mergeSharedSettings(abc, a), abc);
      assert.equal(mergeSharedSettings(abc, abc), abc);
      assert.deepEqual(sharedSettingsAhead(abc, abc).entries, {});
      assert.deepEqual(
        Object.keys(sharedSettingsAhead(abc, a).entries).toSorted(),
        [KEY, "other"].toSorted(),
      );
      // Equal stamps settle the same way from either side.
      const tieA = { entries: { [KEY]: { value: KIWI, at: 7, by: KIWI } } };
      const tieB = { entries: { [KEY]: { value: LYCHEE, at: 7, by: LYCHEE } } };
      assert.deepEqual(
        mergeSharedSettings(tieA, tieB),
        mergeSharedSettings(tieB, tieA),
      );
    },
  );

  await check(
    "stamps: a write outranks everything its copy has seen, even from a clock running behind",
    () => {
      const ahead = withSharedSetting(
        EMPTY_SHARED_SETTINGS,
        KEY,
        KIWI,
        KIWI,
        1_000_000,
      );
      // Lychee's clock is far behind, but it has seen Kiwi's write.
      const behind = withSharedSetting(ahead, KEY, LYCHEE, LYCHEE, 5);
      assert.equal(behind.entries[KEY].at, 1_000_001);
      assert.equal(
        sharedStringSetting(mergeSharedSettings(ahead, behind), KEY),
        LYCHEE,
      );
    },
  );

  await check(
    "clearing: a tombstone outranks a copy still holding the old value",
    () => {
      const set = withSharedSetting(EMPTY_SHARED_SETTINGS, KEY, KIWI, KIWI, 10);
      const cleared = withSharedSetting(set, KEY, null, LYCHEE, 20);
      const merged = mergeSharedSettings(cleared, set);
      assert.equal(merged, cleared);
      assert.equal(sharedStringSetting(merged, KEY), undefined);
      assert.equal(merged.entries[KEY].value, null);
    },
  );

  await check(
    "forward compatibility: a key this build never heard of parses, merges and is offered on",
    () => {
      const future = SharedSettingsDocSchema.parse({
        entries: { "someFutureSetting/x": { value: 3, at: 9, by: LYCHEE } },
      });
      const merged = mergeSharedSettings(EMPTY_SHARED_SETTINGS, future);
      assert.deepEqual(
        sharedSettingsAhead(merged, EMPTY_SHARED_SETTINGS),
        future,
      );
    },
  );

  await check(
    "tolerance: an entry this build cannot hold is left out, and the rest of the document still reads",
    () => {
      const doc = SharedSettingsDocSchema.parse({
        entries: {
          [KEY]: { value: KIWI, at: 3, by: KIWI },
          tooLong: { value: "x".repeat(10_000), at: 4, by: KIWI },
          badStamp: { value: true, at: Number.MAX_SAFE_INTEGER, by: KIWI },
          notAnEntry: 5,
        },
      });
      assert.deepEqual(Object.keys(doc.entries), [KEY]);
    },
  );

  await check(
    "full copy: a new key is refused out loud, while held keys still take writes",
    () => {
      const entries = {};
      for (let i = 0; i < MAX_SHARED_SETTING_ENTRIES; i += 1) {
        entries[`filler/${i}`] = { value: i, at: 1, by: KIWI };
      }
      let doc = { entries };
      const copy = createSharedSettingsCopy(
        {
          read: () => doc,
          transact: (next) => {
            doc = next(doc) ?? doc;
          },
        },
        { deviceId: () => KIWI, announce: () => {} },
      );
      assert.throws(() => copy.set(KEY, LYCHEE), /full/);
      assert.equal(
        copy.set("filler/0", "moved").entries["filler/0"].value,
        "moved",
      );
    },
  );

  await check(
    "host copy: lives in registry.json beside the CLI's keys, stamps with this device, announces only real changes",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "sm-shared-settings-"));
      try {
        writeFileSync(
          join(dir, "registry.json"),
          JSON.stringify({ projects: [{ id: "p1" }], deviceId: KIWI }),
        );
        initDataDirAt(dir);
        const announced = [];
        onSharedSettingsChange((doc) => announced.push(doc));

        assert.deepEqual(sharedSettingsCopy.read(), EMPTY_SHARED_SETTINGS);
        const first = sharedSettingsCopy.set(KEY, LYCHEE);
        assert.equal(first.entries[KEY].by, KIWI);
        assert.equal(announced.length, 1);
        // The same pick again is not a write: no new stamp to outrank
        // a different pick made elsewhere meanwhile.
        assert.deepEqual(sharedSettingsCopy.set(KEY, LYCHEE), first);
        assert.equal(announced.length, 1);
        // A merge that learns nothing is silent, one that learns is not.
        sharedSettingsCopy.merge(first);
        assert.equal(announced.length, 1);
        const newer = {
          entries: {
            [KEY]: { value: KIWI, at: first.entries[KEY].at + 1, by: LYCHEE },
          },
        };
        assert.equal(
          sharedStringSetting(sharedSettingsCopy.merge(newer), KEY),
          KIWI,
        );
        assert.equal(announced.length, 2);

        const onDisk = JSON.parse(
          readFileSync(join(dir, "registry.json"), "utf8"),
        );
        assert.deepEqual(onDisk.projects, [{ id: "p1" }]);
        assert.equal(onDisk.deviceId, KIWI);
        assert.deepEqual(onDisk.sharedSettings, newer);

        // Hand-mangled storage reads as empty instead of throwing, and
        // the next merge fills it back in.
        writeFileSync(
          join(dir, "registry.json"),
          JSON.stringify({ ...onDisk, sharedSettings: { entries: 5 } }),
        );
        assert.deepEqual(sharedSettingsCopy.read(), EMPTY_SHARED_SETTINGS);
        assert.deepEqual(sharedSettingsCopy.merge(newer), newer);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await check(
    "browser copy: served off localStorage through the same contract, announcing only real changes",
    async () => {
      const bridge = webBridge();
      const announced = [];
      bridge.api.sharedSettings.onChanged((doc) => announced.push(doc));
      assert.deepEqual(await bridge.api.sharedSettings.read(), {
        entries: {},
      });
      const doc = await bridge.api.sharedSettings.set(KEY, KIWI);
      assert.equal(doc.entries[KEY].by, bridge.api.deviceId);
      assert.deepEqual(await bridge.api.sharedSettings.read(), doc);
      await bridge.api.sharedSettings.set(KEY, KIWI);
      await bridge.api.sharedSettings.merge(doc);
      assert.equal(announced.length, 1);
      await bridge.stop();
    },
  );

  await check(
    "convergence: three copies never all online together agree after pairwise exchanges",
    async () => {
      const [a, b, c] = [webBridge(), webBridge(), webBridge()];
      // A picks while alone, then meets B. A leaves, C arrives having
      // made an older-looking pick of its own for another setting.
      await a.api.sharedSettings.set(KEY, KIWI);
      await c.api.sharedSettings.set("other", "from-c");
      await exchange(b.api, a.api);
      await exchange(c.api, b.api);
      // C re-picks after hearing of A's pick, so C's must win everywhere.
      await c.api.sharedSettings.set(KEY, LYCHEE);
      await exchange(b.api, c.api);
      await exchange(a.api, b.api);
      const docs = await Promise.all(
        [a, b, c].map((bridge) => bridge.api.sharedSettings.read()),
      );
      assert.deepEqual(docs[0], docs[1]);
      assert.deepEqual(docs[1], docs[2]);
      assert.equal(sharedStringSetting(docs[0], KEY), LYCHEE);
      assert.equal(sharedStringSetting(docs[0], "other"), "from-c");
      await Promise.all([a, b, c].map((bridge) => bridge.stop()));
    },
  );

  done();
}

main().catch(fail);
