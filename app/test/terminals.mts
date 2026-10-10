// Durable proof for the host's terminals (host/lib/terminals): the
// history ring, and the service over real login shells and the engine's
// store.
//
// Asserts:
//   - the history drops terminal queries, keeps its newest chunks under
//     its cap, and answers a reconnect with what came after its seq, or
//     everything with `reset` once that is gone,
//   - an attach streams the history, the size, then the output, and a
//     reconnect from a seq repeats no chunk,
//   - a resize reaches every attached client,
//   - a close ends every attach with an exit and leaves the list,
//   - a quit saves each terminal, and the next start opens it again
//     under its history in the folder it was in,
//   - a worktree terminal whose worktree is gone closes,
//   - a shell running a foreground job counts as busy, and the quit's
//     words name it,
//   - the renderer's feed (lib/terminalFeed.ts) over a link that drops
//     again and again picks up after the last chunk it had: every line
//     comes once, in order.
//
// Run: pnpm test terminals.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import type {
  Terminal,
  TerminalEvent,
  TerminalOwner,
} from "@shigomori/contracts/schemas";
import * as Paths from "@shigomori/engine/Paths";
import * as SavedTerminals from "@shigomori/engine/SavedTerminals";
import * as Migration from "@shigomori/engine/Migration";
import * as Store from "@shigomori/engine/Store";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, it } from "vitest";
import { makeHistory, withoutQueries } from "../host/lib/terminals/history.ts";
import * as Terminals from "../host/lib/terminals/Terminals.ts";
import { busyDetail } from "../shared/busy.ts";
import { attachTerminal } from "../renderer/lib/terminalFeed.ts";
import { makeTracker, tempDir, waitFor } from "./lib/checkKit.mts";

describe("the history", () => {
  it("drops terminal queries and keeps everything else", () => {
    const sent =
      "a\x1b[c\x1b[>c\x1b[6n\x1b[?2026$p\x1b[14t\x1b]11;?\x07\x1b]10;?\x1b\\\x1bP$qm\x1b\\b\x1b[31mred\x1b[0m";
    assert.equal(withoutQueries(sent), "ab\x1b[31mred\x1b[0m");
  });

  it("answers a reconnect with what came after its seq", () => {
    const history = makeHistory(0, "", 10);
    history.append(1, "aaaa");
    history.append(2, "bbbb");
    assert.deepEqual(history.since(1), { data: "bbbb", seq: 2, reset: false });
    assert.deepEqual(history.since(2), { data: "", seq: 2, reset: false });
    assert.deepEqual(history.since(undefined), {
      data: "aaaabbbb",
      seq: 2,
      reset: true,
    });
    // Past the cap, the oldest chunk is cut, and a client that held only
    // up to before it starts over.
    history.append(3, "cccc");
    assert.equal(history.text(), "aabbbbcccc");
    assert.deepEqual(history.since(0), {
      data: "aabbbbcccc",
      seq: 3,
      reset: true,
    });
    assert.deepEqual(history.since(1), {
      data: "bbbbcccc",
      seq: 3,
      reset: false,
    });
    // A chunk bigger than the cap keeps its tail, from a line's start,
    // and a client that held only up to before it starts over.
    history.append(4, "xxxx\nyyyy\nzzzzzzzzzz");
    assert.equal(history.text(), "zzzzzzzzzz");
    assert.deepEqual(history.since(3), {
      data: "zzzzzzzzzz",
      seq: 4,
      reset: true,
    });
    history.append(5, "!");
    assert.deepEqual(history.since(4), { data: "!", seq: 5, reset: false });
    assert.equal(history.text(), "zzzzzzzzz!");
    // A seq the ring never reached is another session's.
    assert.equal(history.since(9).reset, true);
  });

  it("starts a restored terminal at its saved seq", () => {
    const history = makeHistory(7, "saved");
    assert.deepEqual(history.since(7), { data: "", seq: 7, reset: false });
    assert.deepEqual(history.since(undefined), {
      data: "saved",
      seq: 7,
      reset: true,
    });
    history.append(8, "more");
    assert.deepEqual(history.since(7), { data: "more", seq: 8, reset: false });
  });
});

const { track, teardown } = makeTracker();
let root: string;
let dataDir: string;
// The worktrees the proof's start callback still knows.
const worktrees = new Map<string, string>();

beforeAll(() => {
  root = realpathSync(tempDir("sm-terminals-", track));
  dataDir = join(root, "data");
});
afterAll(teardown);

const start = (owner: TerminalOwner) => {
  if (owner.kind === "device") {
    return Effect.succeed<Terminals.Start>({
      env: { ...process.env, PS1: "$ ", TERM: "xterm-256color" },
    });
  }
  const cwd = worktrees.get(owner.worktreeId);
  return cwd === undefined
    ? Effect.fail(new UnknownWorktreeError({ worktreeId: owner.worktreeId }))
    : Effect.succeed<Terminals.Start>({ cwd, env: process.env });
};

// The service as the host builds it, over a store in the proof's data
// dir: one runtime is one run of the app.
const launch = () =>
  ManagedRuntime.make(
    Terminals.layer({ start }).pipe(
      Layer.provideMerge(SavedTerminals.layer),
      Layer.provide(Store.layer((filename) => SqliteClient.make({ filename }))),
      Layer.provide(Migration.layer),
      Layer.provide(Paths.layer("prod")),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { HOME: root, SHIGOMORI_DATA_DIR: dataDir },
          }),
        ),
      ),
    ),
  );

type App = ReturnType<typeof launch>;

const noop = (): void => {};

const withTerminals = <A, E>(
  app: App,
  f: (terminals: Terminals.Terminals["Service"]) => Effect.Effect<A, E>,
) => app.runPromise(Effect.flatMap(Terminals.Terminals, f));

// An attach, collecting what it streams until it ends.
function attach(app: App, terminalId: string, after?: number) {
  const events: TerminalEvent[] = [];
  const fiber = app.runFork(
    Effect.flatMap(Terminals.Terminals, (terminals) =>
      terminals
        .attach(terminalId, after)
        .pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        ),
    ),
  );
  const output = () =>
    events
      .filter((event) => event.kind === "history" || event.kind === "output")
      .map((event) => event.data)
      .join("");
  const lastSeq = () =>
    events.reduce(
      (seq, event) =>
        event.kind === "history" || event.kind === "output" ? event.seq : seq,
      0,
    );
  return { events, output, lastSeq, fiber };
}

describe("the service", () => {
  it("streams history, size and output, and a reconnect repeats nothing", async () => {
    const app = launch();
    try {
      const { terminalId, cwd } = await withTerminals(app, (terminals) =>
        terminals.open({
          owner: { kind: "device" },
          size: { cols: 100, rows: 30 },
        }),
      );
      assert.equal(cwd, root, "the first device terminal starts at home");
      const first = attach(app, terminalId);
      await waitFor(() => first.events.length >= 2, "the attach's head");
      assert.equal(first.events[0]?.kind, "history");
      assert.deepEqual(first.events[1], { kind: "size", cols: 100, rows: 30 });
      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "echo one-$((40+2))\r"),
      );
      await waitFor(() => first.output().includes("one-42"), "the echo");
      const held = first.lastSeq();
      await app.runPromise(Fiber.interrupt(first.fiber));

      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "echo two-$((40+2))\r"),
      );
      const again = attach(app, terminalId, held);
      await waitFor(() => again.output().includes("two-42"), "the second echo");
      const history = again.events[0];
      assert.ok(history?.kind === "history" && !history.reset);
      assert.ok(!again.output().includes("one-42"), "a held chunk came again");
      const seqs = again.events.flatMap((event) =>
        event.kind === "output" ? [event.seq] : [],
      );
      assert.ok(seqs.every((seq, i) => seq > (seqs[i - 1] ?? held)));

      await withTerminals(app, (terminals) =>
        terminals.resize(terminalId, { cols: 80, rows: 24 }),
      );
      await waitFor(
        () =>
          again.events.some(
            (event) => event.kind === "size" && event.cols === 80,
          ),
        "the resize",
      );
      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "stty size\r"),
      );
      await waitFor(() => again.output().includes("24 80"), "the shell's size");

      await withTerminals(app, (terminals) => terminals.close(terminalId));
      await app.runPromise(Fiber.join(again.fiber));
      assert.deepEqual(again.events.at(-1), { kind: "exit", code: null });
      const listed = await app.runPromise(
        Effect.flatMap(Terminals.Terminals, (terminals) =>
          Stream.runHead(terminals.list),
        ),
      );
      assert.deepEqual(Option.getOrNull(listed), []);
    } finally {
      await app.dispose();
    }
  });

  it("an exit ends the attach with its code", async () => {
    const app = launch();
    try {
      const { terminalId } = await withTerminals(app, (terminals) =>
        terminals.open({ owner: { kind: "device" } }),
      );
      const attached = attach(app, terminalId);
      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "exit 3\r"),
      );
      await app.runPromise(Fiber.join(attached.fiber));
      assert.deepEqual(attached.events.at(-1), { kind: "exit", code: 3 });
    } finally {
      await app.dispose();
    }
  });

  it("a quit saves each terminal, and the next start opens it again", async () => {
    const folder = join(root, "somewhere");
    mkdirSync(folder);
    const first = launch();
    let terminalId: string;
    try {
      ({ terminalId } = await withTerminals(first, (terminals) =>
        terminals.open({ owner: { kind: "device" } }),
      ));
      const attached = attach(first, terminalId);
      await withTerminals(first, (terminals) =>
        terminals.write(terminalId, `cd ${folder} && echo moved-$((1+1))\r`),
      );
      await waitFor(() => attached.output().includes("moved-2"), "the cd");
    } finally {
      await first.dispose();
    }

    const second = launch();
    try {
      let reopened: ReadonlyArray<Terminal> = [];
      await waitFor(async () => {
        const listed = await second.runPromise(
          Effect.flatMap(Terminals.Terminals, (terminals) =>
            Stream.runHead(terminals.list),
          ),
        );
        reopened = Option.getOrElse(listed, () => []);
        return reopened.length > 0;
      }, "the saved terminal to open again");
      assert.deepEqual(
        reopened.map((terminal) => [terminal.terminalId, terminal.cwd]),
        [[terminalId, folder]],
      );
      const attached = attach(second, terminalId);
      await waitFor(() => attached.events.length >= 2, "the attach's head");
      assert.ok(attached.output().includes("moved-2"), "the history came back");
      await withTerminals(second, (terminals) =>
        terminals.write(terminalId, "pwd\r"),
      );
      await waitFor(
        () => attached.output().split(folder).length > 2,
        "the fresh shell's pwd",
      );
      // A new device terminal starts where the newest one is.
      const next = await withTerminals(second, (terminals) =>
        terminals.open({ owner: { kind: "device" } }),
      );
      assert.equal(next.cwd, folder);
    } finally {
      await second.dispose();
    }
  });

  it("a worktree's terminal starts in it and closes when it goes", async () => {
    const worktree = join(root, "wt");
    mkdirSync(worktree);
    worktrees.set("W", worktree);
    const app = launch();
    try {
      const terminal = await withTerminals(app, (terminals) =>
        terminals.open({
          owner: { kind: "worktree", projectId: "P", worktreeId: "W" },
        }),
      );
      assert.equal(terminal.cwd, worktree);
      const attached = attach(app, terminal.terminalId);
      await withTerminals(app, (terminals) => terminals.closeMissing);
      assert.equal(attached.events.at(-1)?.kind === "exit", false);
      worktrees.delete("W");
      rmSync(worktree, { recursive: true });
      await withTerminals(app, (terminals) => terminals.closeMissing);
      await app.runPromise(Fiber.join(attached.fiber));
      assert.deepEqual(attached.events.at(-1), { kind: "exit", code: null });
    } finally {
      await app.dispose();
    }
  });

  it("a shell running a foreground job is busy", async () => {
    const app = launch();
    try {
      const { terminalId } = await withTerminals(app, (terminals) =>
        terminals.open({ owner: { kind: "device" } }),
      );
      const busy = () => withTerminals(app, (terminals) => terminals.busy);
      await waitFor(async () => (await busy()) === 0, "an idle prompt");
      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "sleep 30\r"),
      );
      await waitFor(async () => (await busy()) === 1, "the job to start");
      assert.equal(
        busyDetail(
          { runningScripts: 1, inflightDeletes: 0, busyTerminals: 1 },
          "quit",
        ),
        "1 script and 1 terminal are still running. Quitting now will stop them.",
      );
      await withTerminals(app, (terminals) =>
        terminals.write(terminalId, "\x03"),
      );
      await waitFor(async () => (await busy()) === 0, "the job to stop");
    } finally {
      await app.dispose();
    }
  });

  it("the feed picks up after a dropped link with nothing lost or repeated", async () => {
    const app = launch();
    try {
      const { terminalId } = await withTerminals(app, (terminals) =>
        terminals.open({ owner: { kind: "device" } }),
      );
      // A link to the host that the proof drops at will: each drop ends
      // the attach under way the way a closed socket does.
      let drop = noop;
      let attaches = 0;
      const api = {
        terminals: {
          attach: (
            input: { terminalId: string; after?: number },
            observer: {
              value: (event: TerminalEvent) => void;
              end: (failure?: unknown) => void;
            },
          ) => {
            attaches += 1;
            const fiber = app.runFork(
              Effect.flatMap(Terminals.Terminals, (terminals) =>
                terminals
                  .attach(input.terminalId, input.after)
                  .pipe(
                    Stream.runForEach((event) =>
                      Effect.sync(() => observer.value(event)),
                    ),
                  ),
              ),
            );
            drop = () => {
              app.runFork(Fiber.interrupt(fiber));
              observer.end(new Error("the link dropped"));
            };
            return () => void app.runFork(Fiber.interrupt(fiber));
          },
        },
      };
      let screen = "";
      let resets = 0;
      const stop = attachTerminal(
        api,
        terminalId,
        {
          replay: (data, reset) => {
            if (reset) {
              resets += 1;
              screen = "";
            }
            screen += data;
          },
          write: (data) => {
            screen += data;
          },
          resize: () => {},
        },
        () => {},
      );
      await withTerminals(app, (terminals) =>
        terminals.write(
          terminalId,
          "for i in $(seq 1 300); do echo line-$i; sleep 0.005; done; echo done-$((1+1))\r",
        ),
      );
      await Array.from({ length: 5 }).reduce<Promise<void>>(
        (previous) =>
          previous
            .then(() => new Promise((resolve) => setTimeout(resolve, 150)))
            .then(() => drop()),
        Promise.resolve(),
      );
      await waitFor(
        () => screen.includes("done-2"),
        "the loop to finish",
        15_000,
      );
      stop();
      const lines = [...screen.matchAll(/line-(\d+)\r\n/g)].map((m) =>
        Number(m[1]),
      );
      assert.deepEqual(
        lines,
        Array.from({ length: 300 }, (_, i) => i + 1),
      );
      assert.equal(resets, 1, "only the first attach starts over");
      assert.ok(attaches >= 6, "every drop attached again");
    } finally {
      await app.dispose();
    }
  });
});
