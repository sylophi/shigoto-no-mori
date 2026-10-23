// Durable proof that a move's files step is under way on the device
// that serves it (host/mirror/serving.ts), so a quit there asks about
// it as about the landing before it. The device that runs the step
// tells the other, through its REAL gateway (host/mirror/MirrorGateway.ts,
// registry.ts transferInto), over a REAL direct wire. Asserts:
//   - a stream for a transfer into the served worktree reads as a
//     worktree arriving while it is open, and nothing once it closes,
//   - a live mirror's stream reads as nothing under way.
//
// Run: pnpm test transfer-serving.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { mirrorContract } from "@shigomori/contracts/modules/mirror";
import type { Project } from "@shigomori/contracts/schemas";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { afterAll, beforeAll, it } from "vitest";
import * as FileSync from "@host/fileSync/FileSync";
import * as PeerReach from "@host/ipc/PeerReach";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { addProject } from "@host/lib/projects";
import * as Scripts from "@host/lib/Scripts";
import * as MirrorGateway from "@host/mirror/MirrorGateway";
import { beginTransfer, endTransfer } from "@host/mirror/registry";
import { listMirrorServing } from "@host/mirror/serving";
import { busyDetail } from "@shared/busy";
import { initDataDirAt } from "@shared/paths";
import {
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
  waitFor,
} from "./lib/checkKit.mts";
import {
  bootDirectWire,
  type DirectWire,
  LISTENER,
} from "./lib/directBoot.mts";
import { engineDataDir, runHost } from "./lib/hostRuntime.mts";

scrubProcessGitEnv();
const { track, teardown } = makeTracker();
const git = sandboxGit();
let project: Project;
let worktreeId: string;
let toListener: DirectWire["toListener"];
let gateway: ManagedRuntime.ManagedRuntime<MirrorGateway.MirrorGateway, never>;

// The served side's `file-sync serve` child, holding its channel open.
const fileSync = Layer.succeed(
  FileSync.FileSync,
  FileSync.FileSync.of({
    spawn: () => Effect.die(new Error("not in this check")),
    serve: (_root, _dataDir, until) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* until.pipe(
          Effect.andThen(Scope.close(scope, Exit.void)),
          Effect.forkDetach,
        );
        return {
          pid: 0,
          scope,
          stream: new Duplex({
            read() {},
            write(_chunk, _encoding, done) {
              done();
            },
            final(done) {
              this.push(null);
              done();
            },
          }),
          stderr: new PassThrough(),
        };
      }),
  }),
);

beforeAll(async () => {
  initDataDirAt(engineDataDir);
  const root = tempDir("sm-transfer-serving-", track);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "a");
  const copy = join(root, "copy");
  git(repo, "worktree", "add", "-q", "-b", "feature", copy);
  worktreeId = worktreeIdFromPath(copy);
  project = await runHost(addProject(repo));
  let listener: DirectWire["listener"];
  ({ listener, toListener } = await bootDirectWire(track, {
    provide: fileSync,
    contracts: [[mirrorContract, mirrorHandlers]],
  }));
  listener.setAccepts(true);
  gateway = ManagedRuntime.make(
    MirrorGateway.layer.pipe(
      Layer.provide(
        Layer.succeed(
          PeerReach.PeerReach,
          PeerReach.make({
            transportFor: () => toListener.transport,
            channelsFor: () => toListener.channels,
          }),
        ),
      ),
    ),
  );
  track(() => gateway.dispose());
}, 120_000);
afterAll(teardown);

const underWay = async () =>
  busyDetail(
    await runHost(Effect.flatMap(Scripts.Scripts, (scripts) => scripts.busy)),
    "quit",
  );

// The running side's daemon, dialing its gateway for the stream, as
// file-sync/engine.go does. Answers the socket once the far end serves.
async function dial() {
  const listening = Option.getOrThrow(
    await gateway.runPromise(
      MirrorGateway.MirrorGateway.use((gw) => gw.listening),
    ),
  );
  const [host, port] = listening.address.split(":");
  const socket = netConnect(Number(port), host);
  track(() => socket.destroy());
  socket.write(
    `${JSON.stringify({
      token: listening.token,
      deviceId: LISTENER,
      projectId: project.id,
      worktreeId,
    })}\n`,
  );
  const answer = await new Promise<string>((resolve, reject) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("\n")) resolve(text.slice(0, text.indexOf("\n")));
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
  });
  assert.equal(answer, "ok");
  await waitFor(
    () => listMirrorServing().length === 1,
    "the other device to serve the stream",
  );
  return socket;
}

async function hangUp(socket: ReturnType<typeof netConnect>) {
  socket.destroy();
  await waitFor(
    () => listMirrorServing().length === 0,
    "the stream to end with its socket",
  );
}

it("a transfer's stream into the served worktree reads as a worktree arriving until it closes", async () => {
  const token = beginTransfer({
    deviceId: LISTENER,
    worktreeId,
    transfer: "in",
  });
  try {
    const socket = await dial();
    assert.equal(
      await underWay(),
      "A worktree is still arriving. Quitting now will interrupt it.",
    );
    await hangUp(socket);
    await waitFor(
      async () => (await underWay()) === null,
      "nothing under way once the stream ends",
    );
  } finally {
    endTransfer(token);
  }
});

it("a live mirror's stream reads as nothing under way", async () => {
  const socket = await dial();
  assert.equal(await underWay(), null);
  await hangUp(socket);
});
