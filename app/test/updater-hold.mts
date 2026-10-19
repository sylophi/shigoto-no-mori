// Durable proof for the updater letting go of the data folder before a
// move takes it (main/electron/updater.ts hold): a check whose
// staging is under way is ended, and the hold answers only once it has;
// past the hold no check or install starts. The engine's Updater is a
// stand-in whose staging never finishes on its own, and electron, the
// host and the flavor are the small parts of them the updater reads.
//
// Run: pnpm test updater-hold.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, it, vi } from "vitest";
import * as Updater from "@shigomori/engine/Updater";
import { flavorNames } from "@shigomori/engine/flavor";
import { dataDir, initDataDirAt } from "@shared/paths";
import { waitFor } from "./lib/checkKit.mts";

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "1.0.0",
    quit: () => {},
  },
}));
vi.mock("../main/flavor", () => ({
  flavor: "prod",
  names: flavorNames("prod"),
}));
vi.mock("../main/electron/cliBinary", () => ({
  requireCliBinary: () => "/usr/bin/true",
}));
vi.mock("../main/hostProcess", () => ({
  hostBusy: () => Effect.succeed({ scripts: [], terminals: [] }),
  noteUpdaterState: () => {},
}));

const { currentUpdaterState, layer, updaterCalls } =
  await import("../main/electron/updater");

initDataDirAt(mkdtempSync(join(tmpdir(), "updater-hold-")));
afterAll(() => rmSync(dataDir(), { recursive: true, force: true }));

// The updater's layer over a stand-in engine whose staging runs `stage`,
// on `clock` when given, and closed after `body`.
const withUpdater = async (
  stage: Effect.Effect<unknown>,
  body: () => Promise<void>,
  clock?: Layer.Layer<never>,
) => {
  const standIn = Layer.succeed(
    Updater.Updater,
    // oxlint-disable-next-line shigomori/no-double-cast -- the two calls the updater makes here
    {
      stage: () => stage,
      staged: () => Effect.succeed(Option.none()),
    } as unknown as Updater.Updater["Service"],
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Layer.buildWithScope(
      layer.pipe(
        Layer.provide(standIn),
        Layer.provide(NodeServices.layer),
        Layer.provide(clock ?? Layer.empty),
      ),
      scope,
    ),
  );
  try {
    await body();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
};

// First: a hold lasts the rest of the process.
it("the periodic check lives on past a tick that lands while another check runs", async () => {
  const scope = Effect.runSync(Scope.make());
  const clock = await Effect.runPromise(
    Layer.buildWithScope(TestClock.layer(), scope),
  );
  const advance = (duration: Duration.Input) =>
    Effect.runPromise(
      TestClock.adjust(duration).pipe(Effect.provideContext(clock)),
    );
  let staged = 0;
  const finishes: Deferred.Deferred<void>[] = [];
  const stage = Effect.suspend(() => {
    staged += 1;
    const finish = Deferred.makeUnsafe<void>();
    finishes.push(finish);
    return Deferred.await(finish).pipe(Effect.as({ status: "current" }));
  });
  try {
    await withUpdater(
      stage,
      async () => {
        // A check from Settings, its download long.
        await updaterCalls.check();
        await waitFor(() => staged === 1, "Settings' check to stage");
        // The loop's first check lands on it, and waits it out.
        await advance("60 seconds");
        const first = finishes[0];
        assert.ok(first !== undefined);
        Deferred.doneUnsafe(first, Exit.void);
        await waitFor(
          () => currentUpdaterState().kind === "idle",
          "the check to finish",
        );
        // The next tick is the loop's own.
        await advance("10 minutes");
        await waitFor(
          () => staged === 2,
          "the loop to check again after the tick it shared",
        );
        const second = finishes[1];
        if (second !== undefined) Deferred.doneUnsafe(second, Exit.void);
      },
      Layer.succeedContext(clock),
    );
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it("a move's hold ends the check under way, answers once it has, and no check or install starts after it", async () => {
  let staged = 0;
  let ended = false;
  const stage = Effect.suspend(() => {
    staged += 1;
    return Effect.never;
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        ended = true;
      }),
    ),
  );
  await withUpdater(stage, async () => {
    await updaterCalls.check();
    await waitFor(() => staged === 1, "the check to start staging");
    assert.equal(await updaterCalls.hold({ for: "move" }), null);
    assert.ok(ended, "the hold answered with the staging still running");
    assert.equal(currentUpdaterState().kind, "idle");
    await updaterCalls.check();
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(staged, 1, "a check started after the hold");
    await assert.rejects(
      updaterCalls.update(false),
      /The data folder is being moved/,
    );
  });
});
