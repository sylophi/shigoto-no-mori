// Durable proof for the TTL caches (host/lib/util/ttlCache.ts) over
// Effect's Cache: the rules the config stores rely on. Gets that miss
// while a load runs share that load; a rejection is never cached; an
// invalidate during a load discards that load's result (and the value
// cache's peek() never adopts it); expire() keeps peek() serving while
// the next get() reloads; a value past its TTL reloads. Real time,
// short TTLs.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test ttl-cache.
import assert from "node:assert/strict";
import { Effect, Fiber } from "effect";
import {
  getCached,
  makeTtlCache,
  singleFlight,
  ttlMapCache,
  ttlValueCache,
} from "@host/lib/util/ttlCache";
import { delay, makeProof } from "./lib/checkKit.mjs";

const { check, done, fail } = makeProof("ttl-cache proof");

// A loader whose completion the check controls, counting its calls.
function gatedLoader() {
  let release = null;
  let loads = 0;
  const load = (key) =>
    new Promise((resolve, reject) => {
      loads += 1;
      release = { resolve: (v) => resolve(v ?? `${key}#${loads}`), reject };
    });
  return {
    load,
    loads: () => loads,
    settle: (value) => release.resolve(value),
    reject: (error) => release.reject(error),
  };
}

async function main() {
  console.log("ttl-cache proof\n");

  await check(
    "map: concurrent misses share one load, a hit inside the TTL loads nothing, and past the TTL it reloads",
    async () => {
      const loader = gatedLoader();
      const cache = ttlMapCache(60, loader.load);
      const a = cache.get("k");
      const b = cache.get("k");
      await delay(5);
      assert.equal(loader.loads(), 1, "two misses spawned two loads");
      loader.settle();
      assert.equal(await a, "k#1");
      assert.equal(await b, "k#1");
      assert.equal(await cache.get("k"), "k#1", "a hit reloaded");
      assert.equal(loader.loads(), 1);
      await delay(80);
      const late = cache.get("k");
      await delay(5);
      assert.equal(loader.loads(), 2, "a stale entry did not reload");
      loader.settle();
      assert.equal(await late, "k#2");
    },
  );

  await check(
    "map: a rejection reaches every sharer and is never cached; the next get loads again",
    async () => {
      const loader = gatedLoader();
      const cache = ttlMapCache(60, loader.load);
      const a = cache.get("k");
      const b = cache.get("k");
      await delay(5);
      loader.reject(new Error("disk gone"));
      await assert.rejects(a, /disk gone/);
      await assert.rejects(b, /disk gone/);
      const again = cache.get("k");
      await delay(5);
      assert.equal(loader.loads(), 2, "the rejection was served from cache");
      loader.settle();
      assert.equal(await again, "k#2");
    },
  );

  await check(
    "map: an invalidate during a load hands the sharers that load's value but never caches it, and clear() drops every key",
    async () => {
      const loader = gatedLoader();
      const cache = ttlMapCache(60_000, loader.load);
      const stale = cache.get("k");
      await delay(5);
      cache.invalidate("k");
      loader.settle("pre-write");
      assert.equal(await stale, "pre-write", "the sharer lost its answer");
      const fresh = cache.get("k");
      await delay(5);
      assert.equal(loader.loads(), 2, "the pre-write value was re-cached");
      loader.settle("post-write");
      assert.equal(await fresh, "post-write");
      assert.equal(await cache.get("k"), "post-write");
      cache.clear();
      const after = cache.get("k");
      await delay(5);
      assert.equal(loader.loads(), 3, "clear() kept the entry");
      loader.settle();
      await after;
    },
  );

  await check(
    "value: peek() serves the last value past the TTL and past expire(), answers null after invalidate(), and never adopts a load that invalidate() overtook",
    async () => {
      const loader = gatedLoader();
      const cache = ttlValueCache(60, () => loader.load("v"));
      assert.equal(cache.peek(), null, "peek before any load");
      const first = cache.get();
      await delay(5);
      loader.settle("one");
      assert.equal(await first, "one");
      assert.equal(cache.peek(), "one");
      await delay(80);
      assert.equal(cache.peek(), "one", "peek forgot a value past its TTL");
      cache.expire();
      assert.equal(cache.peek(), "one", "expire() dropped the value");
      const reloaded = cache.get();
      await delay(5);
      assert.equal(loader.loads(), 2, "expire() did not force a reload");
      loader.settle("two");
      assert.equal(await reloaded, "two");
      assert.equal(cache.peek(), "two");
      // invalidate() during a load: the value reaches the caller, and
      // neither the cache nor peek() keeps it.
      cache.expire();
      const overtaken = cache.get();
      await delay(5);
      cache.invalidate();
      assert.equal(cache.peek(), null, "invalidate() kept the value");
      loader.settle("stale");
      assert.equal(await overtaken, "stale");
      assert.equal(cache.peek(), null, "peek adopted an overtaken load");
      const next = cache.get();
      await delay(5);
      assert.equal(loader.loads(), 4, "the overtaken value was re-cached");
      loader.settle("three");
      assert.equal(await next, "three");
      assert.equal(cache.peek(), "three");
    },
  );

  await check(
    "value: a load that expire() overtook never puts its older value back into peek() when it lands after the newer one",
    async () => {
      // Two loads in flight at once: the loader hands out one release
      // per load, so this check tracks them by hand.
      const releases = [];
      let loads = 0;
      const cache = ttlValueCache(60_000, () => {
        loads += 1;
        return new Promise((resolve) => releases.push(resolve));
      });
      const first = cache.get();
      await delay(5);
      cache.expire();
      const second = cache.get();
      await delay(5);
      assert.equal(loads, 2, "expire() did not start a fresh load");
      releases[1]("post-write");
      assert.equal(await second, "post-write");
      assert.equal(cache.peek(), "post-write");
      releases[0]("pre-write");
      assert.equal(await first, "pre-write", "the sharer lost its answer");
      assert.equal(
        cache.peek(),
        "post-write",
        "peek went back to the old value",
      );
      assert.equal(
        await cache.get(),
        "post-write",
        "the old value was re-cached",
      );
    },
  );

  await check(
    "single flight and getCached: one lookup per burst, nothing settled served again, and a get that lands on a lookup being torn down starts afresh",
    async () => {
      let lookups = 0;
      let refusing = false;
      // A lookup that takes a while to wind down once interrupted (the
      // first stretch cannot be interrupted, as a directory read in
      // flight cannot), then answers.
      const lookup = (key) =>
        Effect.gen(function* () {
          lookups += 1;
          yield* Effect.uninterruptible(Effect.sleep("40 millis"));
          yield* Effect.sleep("20 millis");
          if (refusing) return yield* Effect.fail(new Error(`no ${key}`));
          return `${key}#${lookups}`;
        });
      const flight = singleFlight(lookup);
      // A burst shares one lookup; the next caller after it looks up
      // again, since a settled single flight is never served twice.
      const [a, b] = await Promise.all([
        Effect.runPromise(flight("k")),
        Effect.runPromise(flight("k")),
      ]);
      assert.equal(a, "k#1");
      assert.equal(b, "k#1");
      assert.equal(lookups, 1, "a burst spawned two lookups");
      assert.equal(await Effect.runPromise(flight("k")), "k#2");
      // The lone caller leaves; the lookup it started is being torn
      // down (40 ms of it cannot be interrupted). A caller arriving in
      // that window is not handed the interruption: it looks up anew.
      const abandoned = Effect.runFork(flight("k"));
      await delay(5);
      const interrupting = Effect.runPromise(Fiber.interrupt(abandoned));
      await delay(5);
      const late = await Effect.runPromise(flight("k"));
      await interrupting;
      assert.equal(late, "k#4", `the late caller got ${late}`);
      assert.equal(lookups, 4);
      // getCached on a TTL cache: a failure is handed out and dropped,
      // so the next get looks up again rather than serving it.
      const cache = makeTtlCache(lookup, "1 minute");
      refusing = true;
      await assert.rejects(Effect.runPromise(getCached(cache, "k")), /no k/);
      refusing = false;
      assert.equal(await Effect.runPromise(getCached(cache, "k")), "k#6");
      assert.equal(
        await Effect.runPromise(getCached(cache, "k")),
        "k#6",
        "a success inside its TTL was not served",
      );
    },
  );

  done();
}

main().catch(fail);
