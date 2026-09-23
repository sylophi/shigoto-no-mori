// Durable proof for the data-dir stores (host/lib/config/global.ts and
// host/lib/config/store.ts) against a sandbox data dir:
//
// - the global-config write lock (a Semaphore of one) serializes two
//   concurrent read-modify-writes so neither update is lost, and the
//   same two writes without it do lose one (so the check can fail);
// - onGlobalConfigChange (a PubSub subscriber per listener) fires on
//   every invalidate, survives a throwing sibling, and stops on
//   unsubscribe;
// - registry.json keys decode against their schemas: an unknown key,
//   and an unknown field on a project row, survive a read-modify-write;
//   a malformed file or value fails the strict read, refuses the write
//   and reads as the fallback on the lenient one; a malformed device id
//   reads as absent so it can be re-minted;
// - readGlobalConfigFresh bypasses the 5 s TTL that readGlobalConfig
//   serves from.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test config-store.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delay, makeProof } from "./lib/checkKit.mjs";

const { initDataDirAt } = await import("../host/lib/util/paths.ts");
const {
  invalidateGlobalConfigCache,
  onGlobalConfigChange,
  readGlobalConfig,
  readGlobalConfigFresh,
  withGlobalConfigWriteLock,
} = await import("../host/lib/config/global.ts");
const {
  DEVICE_ID_KEY,
  PROJECTS_KEY,
  SHELVED_KEY,
  registryStore,
  stateStore,
  PROJECTS_SORT_KEY,
} = await import("../host/lib/config/store.ts");

const { check, done, fail } = makeProof("config-store proof");

const dataDir = realpathSync(
  mkdtempSync(join(tmpdir(), "sm-config-store-data-")),
);
initDataDirAt(dataDir);

const configPath = join(dataDir, "config.json");
const registryPath = join(dataDir, "registry.json");
const statePath = join(dataDir, "state.json");

const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

// A read-modify-write shaped like writeDeviceSettings: a fresh base,
// a pause standing in for the CLI spawn, then the whole document back
// with one key added.
async function addKey(key) {
  const base = await readGlobalConfigFresh();
  await delay(30);
  writeJson(configPath, { ...base, [key]: true });
}

async function main() {
  console.log("config-store proof\n");

  await check(
    "two concurrent global-config writes under the lock keep both updates",
    async () => {
      writeJson(configPath, {});
      await Promise.all([
        withGlobalConfigWriteLock(() => addKey("first")),
        withGlobalConfigWriteLock(() => addKey("second")),
      ]);
      const written = readJson(configPath);
      assert.equal(written.first, true, "the first write was lost");
      assert.equal(written.second, true, "the second write was lost");

      // The control: the same two writes unlocked read the same base,
      // and the later write drops the earlier one's key.
      writeJson(configPath, {});
      await Promise.all([addKey("first"), addKey("second")]);
      const unlocked = readJson(configPath);
      assert.equal(
        Object.keys(unlocked).length,
        1,
        "without the lock one update should have been lost",
      );
    },
  );

  await check("a rejected write releases the lock for the next", async () => {
    const boom = new Error("boom");
    await assert.rejects(
      withGlobalConfigWriteLock(async () => {
        throw boom;
      }),
      (error) => error === boom,
    );
    assert.equal(await withGlobalConfigWriteLock(async () => 7), 7);
  });

  await check(
    "onGlobalConfigChange fires on invalidate and stops on unsubscribe",
    async () => {
      let calls = 0;
      let throwerCalls = 0;
      const unsubscribeThrower = onGlobalConfigChange(() => {
        throwerCalls += 1;
        throw new Error("listener failure");
      });
      const unsubscribe = onGlobalConfigChange(() => {
        calls += 1;
      });
      invalidateGlobalConfigCache();
      invalidateGlobalConfigCache();
      await delay(20);
      assert.equal(calls, 2, "each invalidate reaches the listener");
      assert.equal(throwerCalls, 2, "a throwing listener keeps listening");

      unsubscribe();
      unsubscribeThrower();
      // Twice is harmless.
      unsubscribe();
      invalidateGlobalConfigCache();
      await delay(20);
      assert.equal(calls, 2, "an unsubscribed listener was called");
      assert.equal(throwerCalls, 2);
    },
  );

  await check(
    "an unknown key and an unknown project field survive a registry write",
    async () => {
      writeJson(registryPath, {
        schemaVersion: 1,
        projects: [
          { id: "p1", name: "one", path: "/tmp/one", fromTheFuture: [1] },
          { id: "p2", name: "two", path: "/tmp/two" },
        ],
        someKeyNobodyModels: { nested: true },
      });
      registryStore.updateKey(PROJECTS_KEY, [], (projects) =>
        projects.toReversed(),
      );
      registryStore.updateKey(SHELVED_KEY, {}, (marks) => ({
        ...marks,
        w1: true,
      }));
      const written = readJson(registryPath);
      assert.deepEqual(written.someKeyNobodyModels, { nested: true });
      assert.deepEqual(
        written.projects.map((project) => project.id),
        ["p2", "p1"],
      );
      assert.deepEqual(written.projects[1].fromTheFuture, [1]);
      assert.deepEqual(written[SHELVED_KEY], { w1: true });
      assert.deepEqual(registryStore.readKey(PROJECTS_KEY, [])[1], {
        id: "p1",
        name: "one",
        path: "/tmp/one",
        fromTheFuture: [1],
      });
    },
  );

  await check(
    "a malformed registry.json fails the strict read and reads the fallback on the lenient one",
    async () => {
      // Not JSON at all.
      writeFileSync(registryPath, '{"projects": [');
      assert.throws(
        () => registryStore.readKey(PROJECTS_KEY, []),
        /is not a valid JSON object/,
      );
      assert.equal(registryStore.readHint(PROJECTS_KEY, null), null);

      // JSON, but a key of the wrong shape: the strict read names the
      // file and the key, the write refuses and leaves the file as it
      // was, and the lenient read answers its fallback.
      const malformed = {
        projects: [{ id: "p1", name: 7, path: "/tmp/one" }],
        [SHELVED_KEY]: { w1: true },
      };
      writeJson(registryPath, malformed);
      assert.throws(
        () => registryStore.readKey(PROJECTS_KEY, []),
        (error) =>
          error.message.includes(registryPath) &&
          error.message.includes('"projects"'),
      );
      assert.throws(() =>
        registryStore.updateKey(PROJECTS_KEY, [], (projects) => projects),
      );
      assert.deepEqual(readJson(registryPath), malformed);
      assert.equal(registryStore.readHint(PROJECTS_KEY, null), null);
      // One bad key does not take the others down.
      assert.deepEqual(registryStore.readKey(SHELVED_KEY, {}), { w1: true });

      // state.json the same way.
      writeJson(statePath, { [PROJECTS_SORT_KEY]: "sideways" });
      assert.throws(() => stateStore.readKey(PROJECTS_SORT_KEY, "manual"));
      assert.equal(stateStore.readHint(PROJECTS_SORT_KEY, "manual"), "manual");

      // A malformed device id reads as absent rather than failing, so
      // getDeviceId re-mints it under the lock.
      writeJson(registryPath, { [DEVICE_ID_KEY]: 42 });
      assert.equal(registryStore.readKey(DEVICE_ID_KEY, ""), "");
      writeJson(registryPath, { [DEVICE_ID_KEY]: "not-a-uuid" });
      assert.equal(registryStore.readKey(DEVICE_ID_KEY, ""), "");
      const id = "0b0e3c52-5a2c-4a7e-9d8f-3f1a2b3c4d5e";
      writeJson(registryPath, { [DEVICE_ID_KEY]: id });
      assert.equal(registryStore.readKey(DEVICE_ID_KEY, ""), id);
    },
  );

  await check("readGlobalConfigFresh bypasses the TTL", async () => {
    writeJson(configPath, { marker: 1 });
    invalidateGlobalConfigCache();
    assert.equal((await readGlobalConfig()).marker, 1);
    // Behind the cache's back, as a CLI write would land.
    writeJson(configPath, { marker: 2 });
    assert.equal(
      (await readGlobalConfig()).marker,
      1,
      "the cached read should still serve the value inside its TTL",
    );
    assert.equal((await readGlobalConfigFresh()).marker, 2);
    // And the fresh read refreshed the cache for the readers after it.
    assert.equal((await readGlobalConfig()).marker, 2);
  });

  rmSync(dataDir, { recursive: true, force: true });
  done();
}

main().catch(fail);
