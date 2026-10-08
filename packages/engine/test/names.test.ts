import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import { it } from "vitest";
import doubutsu from "../src/data/doubutsu-names.json" with { type: "json" };
import { pickWorktreeName } from "../src/names.ts";

const pick = (used: Iterable<string>, doubutsuNames: boolean, seed = 1) =>
  pickWorktreeName(new Set(used), doubutsuNames).pipe(
    Random.withSeed(seed),
    Effect.runSync,
  );

it("picks an adjective-animal pair, or a character with doubutsuNames on", () => {
  assert.match(pick([], false), /^[a-z]+-[a-z]+$/);
  assert.ok(doubutsu.names.includes(pick([], true)));
});

it("never picks a used name while the pool has a free one", () => {
  const free = doubutsu.names.at(-1) as string;
  assert.equal(pick(doubutsu.names.slice(0, -1), true), free);
});

it("numbers a name once the pool runs out", () => {
  const taken = doubutsu.names.flatMap((name) => [name, `${name}-2`]);
  assert.match(pick(taken, true), /-3$/);
});
