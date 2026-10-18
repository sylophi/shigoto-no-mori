// Proof for state a device or the window's shell keeps whole and pushes
// on every change, read as a stream (renderer/lib/runtime/atoms.ts,
// pushedState: the updater's state, the guide's, the migration's, the
// command switch's):
//   - the read seeds it, and a push is the newer word: a read answered
//     after a push landed during it is dropped, where a push written
//     into a request's cache was put back by the older read still out,
//   - a read that fails fails the stream, and a peer's answer this
//     build does not read ends it.
//
// Run: pnpm test pushed-state.
import assert from "node:assert/strict";
import { callOf, channelOf } from "@shigomori/contracts/contract";
import { accountContract } from "@shigomori/contracts/modules/account";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import type { Link } from "@shared/ipc/transport";
import { ClientLinks } from "@/lib/runtime/ClientLinks";
import { pushedState } from "@/lib/runtime/atoms";

const READ = callOf(accountContract, "acceptsCommands");
const PUSH = callOf(accountContract, "commandAccessChanged");

// A link whose read answers when told, and whose pushes are sent by hand
// once the stream listens.
function stand() {
  const listeners = new Set<(value: boolean) => void>();
  const answers: Deferred.Deferred<unknown, Error>[] = [];
  let reads = 0;
  const link: Link = {
    local: true,
    call: (channel) => {
      assert.equal(channel, channelOf(READ));
      reads += 1;
      const answer = Deferred.makeUnsafe<unknown, Error>();
      answers.push(answer);
      return Deferred.await(answer);
    },
    view: () => Stream.die(new Error("no views")),
    pushes: () =>
      Stream.callback<unknown>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listen = (value: boolean) => {
              Queue.offerUnsafe(queue, value);
            };
            listeners.add(listen);
            return listen;
          }),
          (listen) => Effect.sync(() => listeners.delete(listen)),
        ),
      ),
  };
  return {
    link,
    reads: () => reads,
    answer: (index: number, value: unknown) => {
      const answer = answers[index];
      assert.ok(answer !== undefined, `no read ${index} out`);
      Effect.runSync(
        value instanceof Error
          ? Deferred.fail(answer, value)
          : Deferred.succeed(answer, value),
      );
    },
    push: (value: boolean) => {
      for (const listen of listeners) listen(value);
    },
    listening: () => listeners.size > 0,
  };
}

const collect = (stream: Stream.Stream<boolean, unknown, ClientLinks>) => {
  const seen: boolean[] = [];
  const fiber = Effect.runFork(
    stream.pipe(
      Stream.runForEach((value) => Effect.sync(() => seen.push(value))),
      Effect.provideService(
        ClientLinks,
        ClientLinks.of({ linkOf: () => ({}) as Link }),
      ),
    ),
  );
  return { seen, fiber };
};

const until = async (holds: () => boolean) => {
  for (let i = 0; i < 200 && !holds(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(holds());
};

it("a push is the newer word than a read still out", async () => {
  const host = stand();
  const { seen, fiber } = collect(
    pushedState(host.link, { read: READ, push: PUSH }) as Stream.Stream<
      boolean,
      unknown,
      ClientLinks
    >,
  );
  await until(() => host.listening() && host.reads() === 1);
  // The push reaches the reader while the read is still out; the read's
  // older answer, landing after it, is dropped.
  host.push(true);
  await until(() => seen.length === 1);
  host.answer(0, false);
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(seen, [true]);
  await Effect.runPromise(Fiber.interrupt(fiber));
});

it("a peer's answer this build does not read ends the stream", async () => {
  const host = stand();
  const { fiber } = collect(
    pushedState(
      { ...host.link, local: false },
      { read: READ, push: PUSH },
    ) as Stream.Stream<boolean, unknown, ClientLinks>,
  );
  await until(() => host.reads() === 1);
  host.answer(0, "not a boolean");
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.ok(Exit.isFailure(exit) && Exit.hasDies(exit));
});

it("a read that fails fails the stream", async () => {
  const host = stand();
  const { fiber } = collect(
    pushedState(host.link, { read: READ, push: PUSH }) as Stream.Stream<
      boolean,
      unknown,
      ClientLinks
    >,
  );
  await until(() => host.reads() === 1);
  host.answer(0, new Error("the shell's port went"));
  const exit = await Effect.runPromise(Fiber.await(fiber));
  assert.ok(Exit.isFailure(exit));
});
