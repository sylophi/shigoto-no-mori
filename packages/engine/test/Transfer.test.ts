// The cross-device verbs against a scripted app on the control wire:
// what each sends, what it makes of each answer, and each way the app
// can fail to be there. The Go sm's own cases (cli/control_test.go) are
// here too, and parity.test.ts holds the two side by side.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Control from "../src/Control.ts";
import { errorDocument, isUsage } from "../src/errorDocument.ts";
import * as Transfer from "../src/Transfer.ts";
import {
  caveatsOf,
  headlineOf,
  type TransferFlags,
  transferOptions,
  type TransferResult,
} from "../src/Transfer.ts";
import { worktreeIdFromPath } from "../src/worktreeLayout.ts";
import * as Worktrees from "../src/Worktrees.ts";
import {
  type FakeApp,
  fakeApp,
  type Frame,
  progress,
  refusal,
  success,
  TOKEN,
} from "./lib/fakeApp.ts";
import { type Engine, type Sandbox, sandbox } from "./lib/sandbox.ts";

// --- the pure parts -------------------------------------------------------

const options = (
  flags: TransferFlags,
  direction: { mirror?: boolean; sent?: boolean; device?: string } = {},
) =>
  Effect.runSync(
    transferOptions(flags, {
      device: direction.device,
      mirror: direction.mirror ?? false,
      sent: direction.sent ?? true,
      binary: "smd",
    }).pipe(
      Effect.match({
        onSuccess: (input) => input,
        onFailure: (error) => ({ usage: isUsage(error), error: error.message }),
      }),
    ),
  );

describe("transfer options", () => {
  it("refuses what the app wouldn't take, as usage", () => {
    for (const bad of [
      { leaveOut: "some" },
      { source: "burn" },
      { setup: true, noSetup: true },
      // The saved rule is the absent default, not a value to spell.
      { leaveOut: "preset" },
    ]) {
      assert.equal((options(bad) as { usage?: boolean }).usage, true);
    }
    // A mirror keeps its source, so a fate for it is a contradiction.
    assert.deepEqual(options({ source: "teardown" }, { mirror: true }), {
      usage: true,
      error: "--source is for send and bring. A mirror keeps its original.",
    });
  });

  it("sends what was asked and nothing else", () => {
    assert.deepEqual(
      options(
        { leaveOut: "gitignored", noSetup: true, source: "shelve" },
        { device: "Studio Mac" },
      ),
      {
        device: "Studio Mac",
        leaveOut: "gitignored",
        setup: false,
        source: "shelve",
      },
    );
    // Nothing asked, nothing sent: the app applies the project's preset
    // and the rule's own setup default.
    assert.deepEqual(options({}), {});
    assert.deepEqual(options({ leaveOut: "", source: "" }), {});
    assert.deepEqual(options({ setup: true }, { mirror: true }), {
      mirror: true,
      setup: true,
    });
  });

  it("passes --clone-into through on a send, and refuses it on a bring or blank", () => {
    for (const mirror of [false, true]) {
      assert.deepEqual(options({ cloneInto: "~/code" }, { mirror }), {
        ...(mirror ? { mirror: true } : {}),
        cloneInto: "~/code",
      });
    }
    assert.deepEqual(
      options({ cloneInto: "~/code" }, { mirror: true, sent: false }),
      {
        usage: true,
        error:
          "--clone-into is for send and mirror --to. A bring lands in this device's own checkout.",
      },
    );
    assert.equal(
      (options({ cloneInto: " " }) as { usage?: boolean }).usage,
      true,
    );
  });
});

const result = (fields: Partial<TransferResult> = {}): TransferResult => ({
  worktree: { name: "feat", path: "/Users/rin/feat" },
  captured: false,
  dirtyApplied: false,
  device: { deviceId: "d1", name: "Studio Mac" },
  copySide: "remote",
  alreadyMirrored: false,
  ...fields,
});

describe("headlines and caveats", () => {
  it("names the direction, the clone, and a mirror already running", () => {
    const cloned = result({
      cloned: { name: "repo", path: "/Users/rin/code/repo" },
    });
    assert.equal(
      headlineOf(cloned, { mirror: true, sent: true }),
      'mirroring feat to "Studio Mac", having cloned repo into /Users/rin/code/repo on "Studio Mac" first',
    );
    assert.equal(
      headlineOf(result(), { mirror: false, sent: true }),
      'sent feat to "Studio Mac"',
    );
    assert.equal(
      headlineOf(result(), { mirror: false, sent: false }),
      'brought feat from "Studio Mac"',
    );
    assert.equal(
      headlineOf(result(), { mirror: true, sent: false }),
      'mirroring feat from "Studio Mac"',
    );
    assert.equal(
      headlineOf(result({ alreadyMirrored: true }), {
        mirror: true,
        sent: true,
      }),
      'feat is already mirrored with "Studio Mac"',
    );
  });

  it("says what didn't hold, and nothing for a clean run", () => {
    assert.deepEqual(
      caveatsOf(
        result({
          captured: true,
          dirtyApplied: true,
          files: { crossed: true, error: "" },
          source: { fate: "teardown", done: true, error: "" },
        }),
      ),
      [],
    );
    assert.deepEqual(
      caveatsOf(
        result({
          captured: true,
          files: { crossed: false, error: "peer went away" },
          source: {
            fate: "teardown",
            done: false,
            error: "it changed after the send",
          },
        }),
      ),
      [
        "the uncommitted changes did not apply on the copy, so they exist only on the source",
        "the ignored files did not all cross: peer went away",
        "the source was not removed: it changed after the send",
      ],
    );
  });
});

// --- the verbs against the scripted app -----------------------------------

const noProgress = () => Effect.void;
const headline = (doc: unknown) => (doc as { headline: string }).headline;

let box: Sandbox;
let app: FakeApp | undefined;
beforeEach(() => {
  box = sandbox();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await box.remove();
});

// The app, published where the engine's data dir is.
const serve = async (
  reply: (request: Frame) => ReadonlyArray<Frame>,
  busy = false,
) => {
  app = await fakeApp(reply, { busy });
  box.write("control.json", app.file());
  return app;
};

// A project "repo" with the worktree "fox".
const seed = () => {
  const repo = box.repo("repo");
  box.write("registry.json", {
    projects: [{ id: "P1", name: "repo", path: repo }],
  });
  const fox = join(repo, ".shigomori", "worktrees", "fox");
  box.git(repo, "worktree", "add", "-q", "-b", "fox", fox);
  return { repo, fox };
};

// A verb's answer, or its failure as the terminal reads it.
const outcome = <A, E>(
  run: (
    transfer: Transfer.Transfer["Service"],
    here: Worktrees.Here,
  ) => Effect.Effect<A, E, Engine>,
  cwd = box.home,
) =>
  box.engine(
    Effect.gen(function* () {
      const here = yield* (yield* Worktrees.Worktrees).here(cwd);
      return yield* run(yield* Transfer.Transfer, here);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          ok: false,
          ...errorDocument(error),
          usage: isUsage(error),
        }),
      ),
    ),
  );

const transferAnswer = {
  worktree: { id: "w9", name: "fox", branch: "fox", path: "/there/fox" },
  captured: true,
  dirtyApplied: false,
  device: { deviceId: "d1", name: "Studio Mac" },
  copySide: "remote",
  files: { crossed: true, conflicts: 0 },
  source: { fate: "shelve", done: true },
};

describe("send, bring and mirror", () => {
  it("sends with the options asked, reporting progress and what didn't hold", async () => {
    const { fox } = seed();
    const served = await serve((request) => [
      progress({ step: "capture", worktreeId: "x" }),
      // Another call's answer on the same socket is not ours.
      { t: "res", id: 99, ok: true, result: "someone else's" },
      progress({ step: "transfer", sent: 1 }),
      progress({ step: "transfer", sent: 2 }),
      progress({ step: "create", createPhase: "checkout" }),
      progress({ step: "create", createPhase: "idle" }),
      { t: "push", channel: "other", payload: { step: "nope" } },
      progress("not a document"),
      success(request, transferAnswer),
    ]);
    const seen: Transfer.Progress[] = [];
    const sent = await outcome((transfer, here) =>
      transfer.send(
        here,
        { ref: "fox" },
        { to: "Studio", leaveOut: "gitignored", noSetup: true },
        (event) => Effect.sync(() => void seen.push(event)),
      ),
    );
    assert.deepEqual(served.received(), [
      {
        hello: { t: "hello", token: TOKEN },
        request: {
          t: "req",
          id: 1,
          channel: "control:send",
          input: {
            device: "Studio",
            leaveOut: "gitignored",
            setup: false,
            projectId: "P1",
            worktreeId: worktreeIdFromPath(fox),
          },
        },
      },
    ]);
    assert.deepEqual(seen, [
      {
        document: { step: "capture", worktreeId: "x", event: "progress" },
        line: "capturing uncommitted changes",
      },
      {
        document: { step: "transfer", sent: 1, event: "progress" },
        line: "transferring commits",
      },
      {
        document: { step: "transfer", sent: 2, event: "progress" },
        line: undefined,
      },
      {
        document: {
          step: "create",
          createPhase: "checkout",
          event: "progress",
        },
        line: "creating the worktree (checkout)",
      },
      {
        document: { step: "create", createPhase: "idle", event: "progress" },
        line: "creating the worktree",
      },
      { document: undefined, line: undefined },
    ]);
    const caveat =
      "the uncommitted changes did not apply on the copy, so they exist only on the source";
    assert.deepEqual(sent, {
      document: { ...transferAnswer, ok: true, caveats: [caveat] },
      headline: 'sent fox to "Studio Mac"',
      result: {
        worktree: { name: "fox", path: "/there/fox" },
        captured: true,
        dirtyApplied: false,
        device: { deviceId: "d1", name: "Studio Mac" },
        copySide: "remote",
        alreadyMirrored: false,
        files: { crossed: true, error: "" },
        source: { fate: "shelve", done: true, error: "" },
      },
    });
  });

  it("reads an explicit null as absent, as Go does, and a wrong type as unreadable", async () => {
    seed();
    let answered: unknown = null;
    await serve((request) => [success(request, answered)]);
    const sent = () =>
      outcome((transfer, here) =>
        transfer.send(here, { ref: "fox" }, {}, noProgress),
      );
    const zero = {
      worktree: { name: "", path: "" },
      captured: false,
      dirtyApplied: false,
      device: { deviceId: "", name: "" },
      copySide: "",
      alreadyMirrored: false,
    };
    assert.deepEqual(await sent(), {
      document: { ok: true, caveats: [] },
      headline: 'sent  to ""',
      result: zero,
    });
    answered = {
      worktree: { name: "fox", path: null },
      copySide: null,
      cloned: null,
      files: null,
      source: { fate: "keep", done: false, error: null },
    };
    assert.deepEqual(await sent(), {
      document: {
        ...(answered as object),
        ok: true,
        caveats: ["the source was not : "],
      },
      headline: 'sent fox to ""',
      result: {
        ...zero,
        worktree: { name: "fox", path: "" },
        source: { fate: "keep", done: false, error: "" },
      },
    });
    answered = { captured: "yes" };
    assert.deepEqual(await sent(), {
      ok: false,
      error:
        "The app answered control:send with something this CLI can't read. The two may be different versions.",
      usage: false,
    });
  });

  it("brings a peer's worktree by the name given, and mirrors either way", async () => {
    seed();
    const served = await serve((request) => [
      success(request, {
        ...transferAnswer,
        copySide: "local",
        cloned: { name: "repo", path: "/there/repo" },
      }),
    ]);
    const brought = await outcome((transfer, here) =>
      transfer.bring(
        here,
        { ref: "owl", project: "repo" },
        { from: "Studio", source: "keep" },
        noProgress,
      ),
    );
    assert.equal(
      headline(brought),
      'brought fox from "Studio Mac", having cloned repo into /there/repo on "Studio Mac" first',
    );
    const mirroredHere = await outcome((transfer, here) =>
      transfer.mirror(
        here,
        { ref: "owl", projectId: "P1" },
        { from: "Studio" },
        noProgress,
      ),
    );
    assert.match(headline(mirroredHere), /^mirroring fox from "Studio Mac"/);
    const mirroredThere = await outcome((transfer, here) =>
      transfer.mirror(
        here,
        { ref: "repo/fox" },
        { cloneInto: "~/code" },
        noProgress,
      ),
    );
    assert.match(headline(mirroredThere), /^mirroring fox to "Studio Mac"/);
    assert.deepEqual(
      served.received().map(({ request }) => request),
      [
        {
          t: "req",
          id: 1,
          channel: "control:bring",
          input: {
            device: "Studio",
            source: "keep",
            projectId: "P1",
            worktree: "owl",
          },
        },
        {
          t: "req",
          id: 1,
          channel: "control:bring",
          input: {
            device: "Studio",
            mirror: true,
            projectId: "P1",
            worktree: "owl",
          },
        },
        {
          t: "req",
          id: 1,
          channel: "control:send",
          input: {
            mirror: true,
            cloneInto: "~/code",
            projectId: "P1",
            worktreeId: worktreeIdFromPath(
              join(box.home, "repo", ".shigomori", "worktrees", "fox"),
            ),
          },
        },
      ],
    );
  });

  it("refuses a blank device, a wrong direction and a bring with no name before asking", async () => {
    seed();
    const served = await serve(() => []);
    const refusedWith = async (
      run: (
        transfer: Transfer.Transfer["Service"],
        here: Worktrees.Here,
      ) => Effect.Effect<unknown, unknown, Engine>,
      error: string,
    ) =>
      assert.deepEqual(await outcome(run), { ok: false, error, usage: true });
    // Before the worktree is looked for: there is no "nope".
    await refusedWith(
      (transfer, here) =>
        transfer.send(here, { ref: "nope" }, { to: "" }, noProgress),
      "--to needs a device: its name, the start of its name, or its id (smd devices).",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.bring(here, { ref: "nope" }, { from: "  " }, noProgress),
      "--from needs a device: its name, the start of its name, or its id (smd devices).",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.send(here, { ref: "nope" }, { from: "Studio" }, noProgress),
      "send goes --to a device. To move one here: smd worktrees bring <worktree> --from <device>.",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.bring(here, { ref: "nope" }, { to: "Studio" }, noProgress),
      "bring comes --from a device. To move one there: smd worktrees send [<name>] --to <device>.",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.mirror(here, {}, { to: "Studio", from: "Laptop" }, noProgress),
      "A mirror goes one way: --to a device, or --from one.",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.bring(
          here,
          { project: "repo" },
          { from: "Studio" },
          noProgress,
        ),
      "Which worktree? `smd worktrees list --remote` shows what your other devices hold.",
    );
    await refusedWith(
      (transfer, here) =>
        transfer.bring(
          here,
          { ref: "owl", project: "repo" },
          { cloneInto: "~/code" },
          noProgress,
        ),
      "--clone-into is for send and mirror --to. A bring lands in this device's own checkout.",
    );
    assert.deepEqual(served.received(), []);
  });
});

describe("unmirror, mirrors, devices and a peer's worktrees", () => {
  it("stops a mirror, a copy that stayed its caveat, and says what to do when it isn't in step", async () => {
    const { fox } = seed();
    const mirror = {
      session: "sync_1",
      device: { deviceId: "d1", name: "Studio Mac" },
      localRoot: fox,
      copySide: "remote",
      paused: false,
      status: "watching",
      conflicts: 0,
    };
    let unconfirmed = false;
    const served = await serve((request) => [
      unconfirmed
        ? refusal(request, "The mirror isn't in step.", "stop-unconfirmed")
        : success(request, { mirror, copyStayed: "the copy is busy" }),
    ]);
    const stopped = await outcome((transfer, here) =>
      transfer.unmirror(here, { ref: "fox" }, { force: true }),
    );
    assert.deepEqual(stopped, {
      document: {
        mirror,
        copyStayed: "the copy is busy",
        ok: true,
        caveats: ["the copy is busy"],
      },
      worktree: (stopped as { worktree: unknown }).worktree,
    });
    unconfirmed = true;
    assert.deepEqual(
      await outcome((transfer, here) =>
        transfer.unmirror(here, { ref: "fox" }, { force: false }),
      ),
      {
        ok: false,
        error:
          "The mirror isn't in step.\nStopping removes the copy, so make sure both sides hold the work (smd worktrees mirrors), or pass -f to stop anyway.",
        code: "stop-unconfirmed",
        usage: false,
      },
    );
    assert.deepEqual(
      served.received().map(({ request }) => request),
      [
        {
          t: "req",
          id: 1,
          channel: "control:mirrorStop",
          input: {
            projectId: "P1",
            worktreeId: worktreeIdFromPath(fox),
            force: true,
          },
        },
        {
          t: "req",
          id: 1,
          channel: "control:mirrorStop",
          input: { projectId: "P1", worktreeId: worktreeIdFromPath(fox) },
        },
      ],
    );
  });

  it("lists mirrors with no input, and devices scoped by the cwd or a project", async () => {
    const { repo } = seed();
    const served = await serve((request) => [
      success(
        request,
        request["channel"] === "control:mirrors"
          ? { daemon: "stopped", mirrors: [] }
          : {
              thisDevice: { deviceId: "d0", name: "Laptop" },
              devices: [
                {
                  deviceId: "d1",
                  name: "Studio",
                  platform: "darwin",
                  block: "no-grant",
                },
              ],
            },
      ),
    ]);
    assert.deepEqual(await outcome((transfer) => transfer.mirrors), {
      daemon: "stopped",
      mirrors: [],
      ok: true,
    });
    const devices = await outcome((transfer, here) =>
      transfer.devices(here, {}),
    );
    assert.deepEqual(devices, {
      thisDevice: { deviceId: "d0", name: "Laptop" },
      devices: [
        {
          deviceId: "d1",
          name: "Studio",
          platform: "darwin",
          block: "no-grant",
        },
      ],
      ok: true,
    });
    // Scoped by the cwd, and by the project's id.
    await outcome((transfer, here) => transfer.devices(here, {}), repo);
    await outcome((transfer, here) =>
      transfer.devices(here, { projectId: "P1" }),
    );
    assert.deepEqual(
      served.received().map(({ request }) => request),
      [
        { t: "req", id: 1, channel: "control:mirrors" },
        { t: "req", id: 1, channel: "control:devices", input: {} },
        {
          t: "req",
          id: 1,
          channel: "control:devices",
          input: { projectId: "P1" },
        },
        {
          t: "req",
          id: 1,
          channel: "control:devices",
          input: { projectId: "P1" },
        },
      ],
    );
  });

  it("lists a peer's worktrees flat, each saying whose, and who wasn't asked", async () => {
    seed();
    const served = await serve((request) => [
      success(request, {
        worktrees: [
          {
            device: { deviceId: "d1", name: "Studio", extra: 1 },
            projectId: "Q1",
            worktree: {
              id: "w1",
              name: "owl",
              branch: "owl-b",
              path: "/s/owl",
            },
          },
        ],
        unreachable: ["Laptop"],
      }),
    ]);
    assert.deepEqual(
      await outcome((transfer, here) =>
        transfer.peerWorktrees(here, { project: "repo", from: "Studio" }),
      ),
      {
        document: [
          {
            id: "w1",
            name: "owl",
            branch: "owl-b",
            path: "/s/owl",
            device: { deviceId: "d1", name: "Studio" },
          },
        ],
        project: { id: "P1", name: "repo", path: join(box.home, "repo") },
        unreachable: ["Laptop"],
      },
    );
    assert.deepEqual(
      await outcome((transfer, here) =>
        transfer.peerWorktrees(here, { project: "repo", from: " " }),
      ),
      {
        ok: false,
        error:
          "--from needs a device: its name, the start of its name, or its id (smd devices).",
        usage: true,
      },
    );
    assert.deepEqual(
      served.received().map(({ request }) => request),
      [
        {
          t: "req",
          id: 1,
          channel: "control:peerWorktrees",
          input: { projectId: "P1", device: "Studio" },
        },
      ],
    );
  });
});

describe("the control wire", () => {
  const mirrors = () => outcome((transfer) => transfer.mirrors);
  const notRunning = {
    ok: false,
    error:
      "The Shigoto no Mori app isn't running, and it is what reaches your other devices. Start it with `pnpm dev` in a checkout, sign in, and try again.",
    code: "app-not-running",
    usage: false,
  };
  // control.json in the engine's own data dir, which exists once the
  // engine has run.
  const publish = (content: unknown) => {
    const dir = join(box.home, "engine");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "control.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  };

  it("reads every dead end as the app not running", async () => {
    assert.deepEqual(await mirrors(), notRunning);
    publish("{not json");
    assert.deepEqual(await mirrors(), notRunning);
    // A pid far past any live one: the file a crashed app left behind.
    publish({ pid: 2 ** 22 - 7, port: 1, token: TOKEN });
    assert.deepEqual(await mirrors(), notRunning);
    // A live pid whose port nothing listens on.
    const gone = await fakeApp(() => []);
    await gone.close();
    publish(gone.file());
    assert.deepEqual(await mirrors(), notRunning);
    // A listener that refuses the token.
    app = await fakeApp(() => []);
    publish(app.file("stale-token"));
    assert.deepEqual(await mirrors(), notRunning);
    assert.deepEqual(app.received(), [
      { hello: { t: "hello", token: "stale-token" } },
    ]);
  });

  it("tells a busy app from an absent one", async () => {
    await serve(() => [], true);
    assert.deepEqual(await mirrors(), {
      ok: false,
      error:
        "The app is serving as many smd commands as it takes at once. Try again in a moment.",
      code: "app-busy",
      usage: false,
    });
  });

  it("says so when the app goes away mid-call, and not that it isn't running", async () => {
    await serve(() => [progress({ step: "transfer" })]);
    assert.deepEqual(await mirrors(), {
      ok: false,
      error:
        "Lost the connection to the app before it answered. A transfer it had started is cancelled and rolled back. Anything else keeps running there: check the app, or `sm worktrees mirrors`.",
      usage: false,
    });
  });

  it("carries the app's own words and code, and refuses an answer it can't read", async () => {
    let refusing = true;
    await serve((request) => [
      refusing
        ? refusal(
            request,
            "Several devices could take part.",
            "ambiguous-device",
          )
        : success(request, { daemon: 5 }),
    ]);
    assert.deepEqual(await mirrors(), {
      ok: false,
      error: "Several devices could take part.",
      code: "ambiguous-device",
      usage: false,
    });
    refusing = false;
    assert.deepEqual(await mirrors(), {
      ok: false,
      error:
        "The app answered control:mirrors with something this CLI can't read. The two may be different versions.",
      usage: false,
    });
  });

  it("says the connection was lost, in the write's words, when the request can't be sent", () => {
    assert.equal(
      new Control.RequestUnsent({ cause: new Error("write EPIPE") }).message,
      "Lost the connection to the app: write EPIPE",
    );
  });

  it("hands each push to the caller before the result", async () => {
    await serve((request) => [
      progress({ step: "capture" }),
      progress({ step: "transfer" }),
      success(request, { session: "sync_1" }),
    ]);
    const pushes: string[] = [];
    const called = await box.engine(
      Effect.flatMap(Effect.service(Control.Control), (control) =>
        control.call("control:send", { projectId: "p" }, (channel, payload) =>
          Effect.sync(
            () =>
              void pushes.push(
                `${channel}/${(payload as { step: string }).step}`,
              ),
          ),
        ),
      ),
    );
    assert.deepEqual(called, { session: "sync_1" });
    assert.deepEqual(pushes, [
      "sync:pullProgress/capture",
      "sync:pullProgress/transfer",
    ]);
  });
});
