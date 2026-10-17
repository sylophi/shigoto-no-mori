// GitHub's stack merge waits for its outcome on an elapsed budget: the
// epoch stepped two hours with monotonic time still spends none of it,
// a poll that fails is asked again, and past the budget the PR itself
// says how the merge ended. The merge is asked for once. Against a
// scripted gh, on a TestClock whose wall clock a step moves alone.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, it } from "vitest";
import * as GitHub from "../src/GitHub.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const PENDING = '{"status":"pending","details":{"message":"","uuid":"u1"}}';
const MERGED_TICKET =
  '{"status":"merged","details":{"message":"","uuid":"u1"}}';
const MERGED_PR = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        state: "MERGED",
        mergeStateStatus: "UNKNOWN",
        reviewDecision: "",
        commits: {
          nodes: [
            { commit: { statusCheckRollup: { contexts: { nodes: [] } } } },
          ],
        },
      },
    },
  },
});

// A gh whose merge-async polls answer `polls` in turn ("fail" exits
// nonzero, as a dropped connection does), the last one every poll after
// it, and whose PR reads as merged. Every call is logged.
function fakeGh(polls: ReadonlyArray<string>) {
  const log = join(box.home, "gh.log");
  const pollFile = join(box.home, "polls");
  writeFileSync(pollFile, `${polls.join("\n")}\n`);
  box.fakeBin(
    "gh",
    `echo "$*" >> '${log}'
case "$*" in
  "api -X PUT repos/{owner}/{repo}/pulls/5/merge-async -f merge_method=squash") echo '${PENDING}';;
  "api repos/{owner}/{repo}/pulls/5/merge-async/u1")
    answer="$(head -n 1 '${pollFile}')"
    if [ "$(wc -l < '${pollFile}')" -gt 1 ]; then
      tail -n +2 '${pollFile}' > '${pollFile}.next' && mv '${pollFile}.next' '${pollFile}'
    fi
    if [ "$answer" = fail ]; then echo "error connecting to api.github.com" >&2; exit 1; fi
    echo "$answer";;
  "api graphql -F number=5 "*) echo '${MERGED_PR}';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
  );
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];
  return {
    calls,
    merges: () => calls().filter((line) => line.startsWith("api -X PUT")),
  };
}

// The TestClock, its wall clock moved by `step` alone.
function steppedClock() {
  let offset = 0;
  const clock = TestClock.testClockWith((test) =>
    Effect.succeed<Clock.Clock>({
      ...test,
      currentTimeMillisUnsafe: () => test.currentTimeMillisUnsafe() + offset,
      currentTimeMillis: Effect.sync(
        () => test.currentTimeMillisUnsafe() + offset,
      ),
      currentTimeNanosUnsafe: () =>
        test.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
      currentTimeNanos: Effect.sync(
        () => test.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
      ),
    }),
  );
  return {
    clock,
    step: (ms: number) => {
      offset += ms;
    },
  };
}

const waitUntil = (done: () => boolean) =>
  Effect.promise(async () => {
    for (let tries = 0; !done(); tries += 1) {
      if (tries > 500) throw new Error("timed out waiting on gh");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

// A gh is logged as it starts, so the merge's loop is given a moment to
// read its answer and sleep again before the clock moves.
const settled = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 150)),
);

// The merge on its own fiber, the test clock moved two seconds at a
// time (the poll's spacing) until it ends.
const merging = (gh: ReturnType<typeof fakeGh>) =>
  Effect.gen(function* () {
    const repo = box.repo("repo");
    box.git(repo, "remote", "add", "origin", "git@github.com:o/r.git");
    const stepped = steppedClock();
    const clock = yield* stepped.clock;
    const github = yield* GitHub.GitHub;
    const fiber = yield* Effect.forkChild(
      github
        .mergeStackAsync(repo, 5, "squash")
        .pipe(Effect.provideService(Clock.Clock, clock)),
    );
    yield* waitUntil(() => gh.merges().length === 1);
    stepped.step(2 * 3_600_000);
    while (fiber.pollUnsafe() === undefined) {
      yield* settled;
      const before = gh.calls().length;
      yield* TestClock.adjust("2 seconds");
      yield* waitUntil(
        () => gh.calls().length > before || fiber.pollUnsafe() !== undefined,
      );
    }
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));

it("a clock step spends none of the merge's budget, and a failed poll is asked again", async () => {
  const gh = fakeGh(["fail", PENDING, MERGED_TICKET]);
  const outcome = await box.engine(merging(gh));
  assert.equal(outcome, "merged");
  assert.equal(gh.merges().length, 1);
});

it("past its budget, the merge reports what the PR says, and asks once", async () => {
  const gh = fakeGh([PENDING]);
  const outcome = await box.engine(merging(gh));
  assert.equal(outcome, "merged");
  assert.equal(gh.merges().length, 1);
  assert.ok(
    gh.calls().some((call) => call.startsWith("api graphql -F number=5")),
  );
});
