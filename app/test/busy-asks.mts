// Proof that a quit or an update kills only a host that left its busy
// ask unanswered (main/core/host/busyAsks.ts):
//   - a host that answers is heard, so Restart to update still asks
//     about an agent running in a terminal (busyDetail, the dialog's
//     words), and is let close,
//   - a host that doesn't answer reads idle, and the quit after kills
//     it, its successor never,
//   - an answer after that takes the kill back, and an ask no quit
//     follows (an update's look before anything is staged) arms
//     nothing,
//   - the prompt follows the work while it is up
//     (main/core/host/busyPrompt.ts): a move that ends takes it down
//     and the quit goes ahead, words that change ask again in the new
//     ones, a re-read the host doesn't answer leaves it up, and the
//     person's own answer stands.
// The update-button walk drives the same on the packaged app: a job in
// a terminal, Restart to update, and the busy dialog.
//
// Run: pnpm test busy-asks.
import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "vitest";
import { type BusyOperations, busyDetail } from "@shared/busy";
import { busyAsks } from "../main/core/host/busyAsks.ts";
import { followBusy } from "../main/core/host/busyPrompt.ts";

const IDLE: BusyOperations = {
  runningScripts: 0,
  inflightDeletes: 0,
  inflightMoves: 0,
  engineChanges: [],
  busyTerminals: 0,
};
const AGENT: BusyOperations = { ...IDLE, busyTerminals: 1 };
const answered = Effect.succeed(Option.some(AGENT));
const silent = Effect.succeed(Option.none<BusyOperations>());

const asks = () => busyAsks<string, BusyOperations>({ idle: IDLE });

it("a host that answers is asked about and let close; one that doesn't reads idle and is killed, its successor never", async () => {
  const busy = asks();
  const heard = await Effect.runPromise(busy.ask("host", answered, true));
  assert.notEqual(
    busyDetail(heard, "restart"),
    null,
    "Restart to update asked nothing about the agent",
  );
  assert.equal(busy.kills("host"), false, "killed though it answered");
  const unheard = await Effect.runPromise(busy.ask("host", silent, true));
  assert.equal(busyDetail(unheard, "restart"), null);
  assert.equal(busy.kills("host"), true);
  assert.equal(busy.kills("next"), false, "its successor killed");
});

it("an answer after it takes the kill back", async () => {
  const busy = asks();
  await Effect.runPromise(busy.ask("host", silent, true));
  await Effect.runPromise(busy.ask("host", answered, true));
  assert.equal(busy.kills("host"), false);
});

it("an ask no quit follows arms nothing", async () => {
  const busy = asks();
  assert.deepEqual(
    await Effect.runPromise(busy.ask("host", silent, false)),
    IDLE,
  );
  assert.equal(busy.kills("host"), false, "a later nuke or relaunch killed it");
});

// What a re-read hears from a host that doesn't answer in time.
const NO_ANSWER = Symbol("no answer");

// The host's answers in turn, the last one standing, and a prompt that
// stays up until its signal takes it down (Electron's resolves as the
// cancel then) or the person answers.
const following = (
  details: readonly (string | null | typeof NO_ANSWER)[],
  answers: readonly (boolean | undefined)[],
) => {
  const reads = [...details];
  const read = () => (reads.length > 1 ? reads.shift() : reads[0]) ?? null;
  const shown: string[] = [];
  let takenDown = 0;
  const result = followBusy({
    detail: async () => {
      const now = read();
      return now === NO_ANSWER ? null : now;
    },
    again: async () => {
      const now = read();
      return now === NO_ANSWER ? Option.none() : Option.some(now);
    },
    show: (detail, signal) => {
      const answer = answers[shown.length];
      shown.push(detail);
      return new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => {
          takenDown += 1;
          resolve(false);
        });
        if (answer !== undefined) setTimeout(() => resolve(answer), 30);
      });
    },
    every: 5,
  });
  return { result, shown, takenDown: () => takenDown };
};

const ARRIVING =
  "A worktree is still arriving. Quitting now will interrupt it.";
const PUSHING = "A push is still being made. Quitting now will interrupt it.";

it("a move that ends while the prompt is up takes it down, and the quit goes ahead", async () => {
  const prompt = following([ARRIVING, ARRIVING, null], []);
  assert.equal(await prompt.result, true);
  assert.deepEqual(prompt.shown, [ARRIVING]);
  assert.equal(prompt.takenDown(), 1);
});

it("words that change while it is up ask again in the new ones", async () => {
  const prompt = following([ARRIVING, PUSHING], [undefined, false]);
  assert.equal(await prompt.result, false);
  assert.deepEqual(prompt.shown, [ARRIVING, PUSHING]);
});

it("a re-read the host doesn't answer in time leaves the prompt up", async () => {
  const prompt = following([ARRIVING, NO_ANSWER], [false]);
  assert.equal(await prompt.result, false);
  assert.deepEqual(prompt.shown, [ARRIVING]);
  assert.equal(prompt.takenDown(), 0);
});

it("a prompt that can't be shown stops asking", async () => {
  let reads = 0;
  await assert.rejects(
    followBusy({
      detail: async () => ARRIVING,
      again: async () => {
        reads += 1;
        return Option.some(ARRIVING);
      },
      show: () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("no prompt")), 20);
        }),
      every: 5,
    }),
  );
  const asked = reads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, asked);
});

it("the person's answer stands, and nothing under way asks nothing", async () => {
  const kept = following([ARRIVING], [false]);
  assert.equal(await kept.result, false);
  assert.deepEqual(kept.shown, [ARRIVING]);
  assert.equal(kept.takenDown(), 0);
  const idle = following([null], []);
  assert.equal(await idle.result, true);
  assert.deepEqual(idle.shown, []);
});
