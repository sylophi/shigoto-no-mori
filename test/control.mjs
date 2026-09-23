// Durable proof for the CLI's cross-device verbs (`sm devices`, `sm
// worktrees send|bring|mirror|unmirror|mirrors`) end to end: the REAL sm
// binary (built from cli/ by this check) finds the REAL control server
// (main/core/control/server.ts) through control.json in a sandboxed
// data dir, the server dispatches the REAL control handlers
// (host/ipc/modules/control.ts), and those run the REAL send and pull
// orchestrators over a REAL direct websocket to device A, which shell
// the same sm binary for every git step against real fixture repos.
// The account's device registry is the one double (it is an HTTP read
// of the hub), and the mirror engine is a recording stand-in: its real
// runs are test/mirror.mjs's and the remote smoke's, while what is
// pinned here is what the control layer asks of it. Asserts:
//   - with no control.json, a dead pid, a dead port or a wrong token,
//     the CLI says the app isn't running (coded app-not-running), and
//     the server refuses a bad hello and serves nothing before one.
//   - a control.json wiped under the running app comes back.
//   - `devices` names the peers, leaves a browser out, and reports
//     offline, no-grant and ready per device for the repo.
//   - `send` lands a dirty worktree on the peer with its commit and its
//     uncommitted work, streams progress events, picks the only ready
//     device unasked, and refuses an unknown device, an ambiguous one
//     and one that doesn't accept commands, each with its code.
//   - a repeat send is refused in the peer's words, and `--source
//     teardown` removes the local source through the send's receipt.
//   - `list --remote` lists the peer's worktrees in list's own shape,
//     `bring` with none points there, and with one (by branch) lands
//     it here and shelves the source over the wire,
//     and a source fate the peer refuses leaves the bring standing
//     with exit 3 and the reason.
//   - a bring whose control socket closes mid-transfer stops there:
//     within a second no temp bundle is left on either side (not at
//     the 10 minute idle sweep), nothing lands, and the incoming ref
//     is swept.
//   - `mirror` sends the worktree and opens a session labelled with
//     the copy on the peer, a second `mirror` answers with the running
//     one, and `unmirror` is refused until the follower reports synced
//     (stop-unconfirmed), then removes the peer's copy.
//   - `mirror --from` copies the peer's worktree here under a session
//     whose copy is local, which `unmirror` removes, original kept.
//   - the listener's bounds, on a TestClock: a connection with no hello
//     is dropped at the hello deadline and a welcomed one is not, the
//     connection past the cap is refused as busy until one closes, the
//     call past the in-flight cap is refused, an unbroken line past a
//     frame is dropped, a closed socket aborts its calls' signal, and
//     stop() tears live connections down before it returns.
//   - typed errors on the control wire: a ControlError keeps its code
//     on the top-level res frame, and a handler's tagged error rides the
//     additive `error` field (tag and fields) beside the message without
//     tripping the CLI, which still prints the message.
//
// Every worktree is named with -p: a landed copy keeps its source's
// folder name, and with both projects in one registry the bare name
// would be ambiguous.
//
// Both "devices" share one node process and one sandboxed data dir
// holding two projects (source and target, one repo identity), as in
// test/sync-transfer.mjs: what separates them is the direct wire.
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test control.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { buildClient } from "@shared/ipc/buildClient";
import { controlContract } from "@shared/ipc/modules/control";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_TRANSFER,
} from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { registerContract } from "@shared/ipc/registerContract";
import { CliRunner } from "@host/ipc/cliDelegate";
import { ControlReach, controlHandlers } from "@host/ipc/modules/control";
import { MirrorEngine } from "@host/ipc/modules/mirror";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { PeerApis } from "@host/ipc/peerSync";
import { installHostRuntime, resetHostRuntime } from "@host/runtime";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import { initDataDirAt } from "@host/lib/util/paths";
import { unknownWorktreeError } from "@shared/errors";
import {
  HELLO_TIMEOUT_MS,
  MAX_IN_FLIGHT_PER_PEER,
  MAX_INBOUND_FRAME_BYTES,
} from "@shared/ipc/socket/frames";
import {
  CONTROL_FILE_NAME,
  createControlServer,
  MAX_CONNECTIONS,
} from "../main/core/control/server.ts";
import {
  cliFailureMessage,
  createCliRunner,
  delay,
  makeProof,
  makeTracker,
  scrubbedGitEnv,
  waitFor,
} from "./lib/checkKit.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";

const execFileP = promisify(execFile);
const cliDir = join(import.meta.dirname, "..", "cli");

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-control-check-")));
const dataDir = join(sandbox, "data");
const smBinary = join(sandbox, "sm");
const controlFile = join(dataDir, CONTROL_FILE_NAME);

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, scrubbedGitEnv(), {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});
const baseEnv = { ...process.env };
const smEnv = { ...baseEnv, SHIGOMORI_DATA_DIR: dataDir };

async function git(cwd, args) {
  return execFileP("git", args, { cwd, env: baseEnv });
}

const { runCli, sm } = createCliRunner(smBinary, smEnv);
const { ok, done, fail } = makeProof("control proof");

// The final {ok} document of a run, and its progress events.
const finalDoc = (result) =>
  result.docs.findLast((doc) => typeof doc.ok === "boolean");
const progressOf = (result) =>
  result.docs.filter((doc) => doc.event === "progress");

async function refused(args, code, pattern) {
  const result = await runCli(args);
  const doc = finalDoc(result);
  assert.equal(result.code, 1, `sm ${args.join(" ")} should exit 1`);
  assert.equal(doc?.ok, false);
  assert.equal(doc?.code, code, `sm ${args.join(" ")}: ${doc?.error}`);
  if (pattern !== undefined) assert.match(doc.error, pattern);
  return doc;
}

// One raw line-delimited exchange with the control server, for the
// hostile paths the CLI itself never takes.
function rawExchange(port, lines, waitMs = 300) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      for (const line of lines) socket.write(`${JSON.stringify(line)}\n`);
      setTimeout(() => socket.destroy(), waitMs);
    });
    socket.on("close", () =>
      resolve(
        received
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line)),
      ),
    );
  });
}

// One raw connection held open, for the bounds: the frames it has
// heard so far, whether the server hung up, and a writer.
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const client = {
      socket,
      frames: [],
      closed: false,
      send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        client.frames.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    socket.on("close", () => {
      client.closed = true;
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      resolve(client);
    });
  });
}

// The answers a raw client has heard.
const resOf = (client) => client.frames.filter((frame) => frame.t === "res");

const pause = delay;

// The listener's bounds, on a server of their own whose fibers run on
// a TestClock, so the hello deadline moves only when told to.
async function proveBounds(track) {
  const rt = ManagedRuntime.make(TestClock.layer());
  track(() => rt.dispose());
  const adjust = async (ms) => {
    // Let the server take the connection (and start its deadline)
    // before the clock moves past it.
    await pause(50);
    await rt.runPromise(TestClock.adjust(ms));
    await pause(50);
  };
  const boundsFile = join(sandbox, "bounds-control.json");
  const server = createControlServer({
    appVersion: () => "9.9.9",
    filePath: () => boundsFile,
    log: () => {
      throw new Error("a throwing logger must not take the server down");
    },
    runtime: { runFork: rt.runFork, runPromise: rt.runPromise },
  });
  // A call that holds until released, keeping its context to read.
  const held = [];
  server.transport.handle("test:hold", (ctx, input) => {
    const { promise, resolve } = Promise.withResolvers();
    held.push({ ctx, release: () => resolve(input) });
    return promise;
  });
  await server.start();
  track(() => server.stop());
  const { port, token } = JSON.parse(readFileSync(boundsFile, "utf8"));
  const welcomed = async () => {
    const client = await rawClient(port);
    client.send({ t: "hello", token });
    await waitFor(() => client.frames.length > 0, "a welcome");
    assert.equal(client.frames[0].t, "welcome");
    return client;
  };

  // The hello deadline: a silent connection goes at the deadline and
  // not before, while a welcomed one outlives it.
  const silent = await rawClient(port);
  const greeted = await welcomed();
  await adjust(HELLO_TIMEOUT_MS - 1);
  assert.equal(silent.closed, false, "dropped before the hello deadline");
  await adjust(1);
  await waitFor(() => silent.closed, "the hello deadline to drop it");
  assert.equal(greeted.closed, false, "the deadline dropped a welcomed one");
  // A malformed line after the hello is dropped, not fatal (and the
  // throwing logger it reaches is contained).
  greeted.socket.write("not json\n");

  // The connection cap: the one past it is refused as busy, and a slot
  // frees when a connection closes.
  const open = [greeted];
  while (open.length < MAX_CONNECTIONS) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time
    open.push(await welcomed());
  }
  const extra = await rawClient(port);
  await waitFor(() => extra.closed, "the busy refusal to end the socket");
  assert.deepEqual(
    extra.frames.map((frame) => [frame.t, frame.code]),
    [["refused", "busy"]],
  );
  // The server hears the close a moment later, so retry briefly.
  open.pop().socket.destroy();
  let freed = null;
  for (let attempt = 0; attempt < 50 && freed === null; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- retried until the close lands
    const client = await rawClient(port);
    client.send({ t: "hello", token });
    // oxlint-disable-next-line no-await-in-loop -- retried until the close lands
    await waitFor(
      () => client.frames.length > 0 || client.closed,
      "an answer to the hello",
    );
    if (client.frames[0]?.t === "welcome") freed = client;
    // oxlint-disable-next-line no-await-in-loop -- retried until the close lands
    else await pause(20);
  }
  assert.ok(freed, "a closed connection never freed its slot");
  open.push(freed);

  // The in-flight cap, on one connection: the call past it is refused
  // at once, and the held ones all answer when released.
  const busy = open[0];
  for (let id = 1; id <= MAX_IN_FLIGHT_PER_PEER + 1; id += 1) {
    busy.send({ t: "req", id, channel: "test:hold", input: id });
  }
  await waitFor(() => resOf(busy).length === 1, "the call past the cap");
  assert.deepEqual(resOf(busy)[0], {
    t: "res",
    id: MAX_IN_FLIGHT_PER_PEER + 1,
    ok: false,
    message: "too many in-flight requests",
  });
  assert.equal(held.length, MAX_IN_FLIGHT_PER_PEER);
  for (const call of held.splice(0)) call.release();
  await waitFor(
    () => resOf(busy).length === MAX_IN_FLIGHT_PER_PEER + 1,
    "the held calls' answers",
  );
  assert.ok(
    resOf(busy)
      .slice(1)
      .every((frame) => frame.ok === true),
  );

  // A closed socket aborts the signal of the calls it was carrying.
  const leaving = open[1];
  leaving.send({ t: "req", id: 1, channel: "test:hold", input: 1 });
  await waitFor(() => held.length === 1, "the held call");
  const leftCall = held.pop();
  assert.equal(leftCall.ctx.signal.aborted, false);
  leaving.socket.destroy();
  await waitFor(() => leftCall.ctx.signal.aborted, "the signal to abort");

  // An unbroken line past a frame's bound ends the connection.
  const flood = open[2];
  flood.socket.write("x".repeat(MAX_INBOUND_FRAME_BYTES + 1));
  await waitFor(() => flood.closed, "the oversized line to end it");

  // stop() is synchronous: the file is gone and the live connections'
  // calls are aborted by the time it returns.
  const last = open[3];
  last.send({ t: "req", id: 1, channel: "test:hold", input: 1 });
  await waitFor(() => held.length === 1, "the held call");
  const lastCall = held.pop();
  server.stop();
  assert.equal(existsSync(boundsFile), false, "stop left the file");
  assert.equal(
    lastCall.ctx.signal.aborted,
    true,
    "stop returned with a connection still live",
  );
  await waitFor(() => open.every((client) => client.closed), "every close");
}

// One row of the account's device registry, as the hub lists it.
const registered = (deviceId, name, platform = "darwin") => ({
  deviceId,
  name,
  platform,
  createdAt: 1,
  lastSeenAt: null,
  online: true,
});

// The mirror engine's stand-in: records what the control layer asks
// of it and reports the sessions it was asked to create. `git` is the
// follower's verdict the stop guard reads.
function fakeMirrorEngine() {
  const sessions = new Map();
  const state = { created: [], terminated: [], git: "following" };
  let next = 0;
  const endpoint = {
    connected: true,
    scanned: true,
    directories: 0,
    files: 0,
    symbolicLinks: 0,
    totalFileSize: 0,
    problems: [],
    excludedProblems: 0,
  };
  return {
    state,
    impl: {
      status: () => "running",
      sessions: () => [...sessions.values()],
      create: async (input) => {
        next += 1;
        const session = `sync_fake${next}`;
        state.created.push(input);
        sessions.set(session, {
          session,
          name: input.name,
          labels: input.labels,
          localRoot: input.localRoot,
          deviceId: input.deviceId,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          remoteRoot: input.remoteRoot,
          paused: false,
          ignores: input.ignores,
          createdAt: Date.now(),
          status: "watching",
          statusText: "Watching for changes",
          successfulCycles: 1,
          conflicts: [],
          excludedConflicts: 0,
          local: endpoint,
          remote: endpoint,
        });
        return session;
      },
      recreate: () => Promise.reject(new Error("not in this check")),
      terminate: async (session) => {
        state.terminated.push(session);
        sessions.delete(session);
      },
      pause: async (session) => {
        sessions.get(session).paused = true;
      },
      resume: async (session) => {
        sessions.get(session).paused = false;
      },
      gitStatus: () => ({ status: state.git, detail: "" }),
      history: () => [],
      noteEvent: () => {},
      forgetHistory: () => {},
    },
  };
}

async function main() {
  console.log("control proof\n");

  await execFileP("go", ["build", "-o", smBinary, "."], {
    cwd: cliDir,
    env: baseEnv,
  });

  // Source repo (this device, B) and its clone (the peer, A), one repo
  // identity between them.
  const sourceRepo = join(sandbox, "source");
  await git(sandbox, ["init", "-q", "-b", "main", "source"]);
  await git(sourceRepo, ["config", "gc.auto", "0"]);
  await git(sourceRepo, ["config", "maintenance.auto", "false"]);
  writeFileSync(join(sourceRepo, "readme.txt"), "base\n");
  await git(sourceRepo, ["add", "-A"]);
  await git(sourceRepo, ["commit", "-qm", "base"]);
  const targetRepo = join(sandbox, "target");
  await git(sandbox, ["clone", "-q", "--", sourceRepo, "target"]);
  await git(targetRepo, ["config", "gc.auto", "0"]);
  await git(targetRepo, ["config", "maintenance.auto", "false"]);

  const addWorktree = async (repo, name, branch, file) => {
    const path = join(sandbox, name);
    await git(repo, ["worktree", "add", "-q", "-b", branch, path]);
    writeFileSync(join(path, file), `${branch}\n`);
    await git(path, ["add", "-A"]);
    await git(path, ["commit", "-qm", branch]);
    return path;
  };
  const sendPath = await addWorktree(
    sourceRepo,
    "wt-send",
    "feat-send",
    "s.txt",
  );
  writeFileSync(join(sendPath, "draft.txt"), "uncommitted\n");
  const tearPath = await addWorktree(
    sourceRepo,
    "wt-tear",
    "feat-tear",
    "t.txt",
  );
  const mirrorPath = await addWorktree(
    sourceRepo,
    "wt-mirror",
    "feat-mirror",
    "m.txt",
  );
  // What `bring` finds on the peer and lands here. It lives in the
  // source repo because a pull lands in the registry's first identity
  // match (the target): see peerOwns below.
  const peerPath = await addWorktree(
    sourceRepo,
    "wt-peer",
    "feat-peer",
    "p.txt",
  );
  writeFileSync(join(peerPath, "peer-draft.txt"), "peer uncommitted\n");
  // What `mirror --from` copies here.
  const inPath = await addWorktree(sourceRepo, "wt-in", "feat-in", "i.txt");

  initDataDirAt(dataDir);
  // The host's services, as the app's runtime provides them
  // (host/runtime.ts). A check that swaps one installs a fresh runtime
  // with the rest unchanged.
  const services = {
    cliRunner: Layer.succeed(CliRunner, {
      runCli,
      requireCliBinary: () => smBinary,
      cliFailureMessage,
    }),
  };
  let installed = null;
  const provide = async (overrides = {}) => {
    if (installed !== null) {
      resetHostRuntime();
      await installed.dispose();
    }
    const layers = Object.values({ ...services, ...overrides });
    installed = ManagedRuntime.make(Layer.mergeAll(...layers));
    installHostRuntime(installed);
  };
  await provide();
  const projectIdOf = async (path) => {
    const result = await sm("projects", "add", "--", path);
    return result.docs.findLast((doc) => typeof doc.id === "string").id;
  };
  // Target first: the peer's identity scan takes the first registry
  // match, which must be the peer's own checkout.
  const targetProjectId = await projectIdOf(targetRepo);
  const sourceProjectId = await projectIdOf(sourceRepo);

  // ---- (1) No app: every way control.json can be wrong reads as
  // "the app isn't running", before any server exists.
  await refused(["devices"], "app-not-running", /isn't running/);
  writeFileSync(
    controlFile,
    JSON.stringify({ pid: 2 ** 22 - 3, port: 1, token: "x", appVersion: "1" }),
  );
  await refused(["devices"], "app-not-running");
  writeFileSync(
    controlFile,
    JSON.stringify({ pid: process.pid, port: 1, token: "x", appVersion: "1" }),
  );
  await refused(["devices"], "app-not-running");
  ok("no control.json, a dead pid and a dead port all read as app-not-running");

  const { track, teardown } = makeTracker();
  try {
    const { listener, peerA } = await bootDirectWire(track, {
      registerHandlers: (binding) => {
        const opts = { validateOutputs: true, onUsageTracked: () => {} };
        registerContract(syncContract, syncHandlers, binding, opts);
        registerContract(worktreesContract, worktreesHandlers, binding, opts);
        registerContract(projectsContract, projectsHandlers, binding, opts);
        registerContract(
          remoteAccessContract,
          remoteAccessHandlers,
          binding,
          opts,
        );
      },
    });
    services.peerApis = Layer.succeed(PeerApis, {
      syncApiFor: () => buildClient(syncContract, peerA.transport),
      worktreesApiFor: () => buildClient(worktreesContract, peerA.transport),
    });
    // The account as the hub would list it: this device, the peer, a
    // machine that is signed in but away, and a browser.
    let connected = ["A"];
    const registry = [
      registered("B", "Agent Box"),
      registered("A", "Studio Mac"),
      registered("C", "Studio Laptop"),
      registered("W", "Chrome on macOS", "web"),
    ];
    // Which of the two projects the peer answers as its checkout of
    // the repo. Both devices read one registry here, so the peer's
    // projects:list holds both: a send's copy lands in the target (the
    // peer's own identity scan), and for the bring the roles swap, the
    // peer's worktree living in the source and landing in the target.
    let peerOwns = targetProjectId;
    const peerTransport = {
      ...peerA.transport,
      invoke: async (channel, input) => {
        const result = await peerA.transport.invoke(channel, input);
        return channel === "projects:list"
          ? result.toSorted((a, b) => (b.id === peerOwns) - (a.id === peerOwns))
          : result;
      },
    };
    const controlImpl = {
      listDevices: async () => registry,
      thisDeviceId: () => "B",
      connectedDeviceIds: async () => connected,
      peerTransportFor: () => peerTransport,
    };
    services.control = Layer.succeed(ControlReach, controlImpl);
    const engine = fakeMirrorEngine();
    services.mirror = Layer.succeed(MirrorEngine, engine.impl);
    await provide();

    const control = createControlServer({
      appVersion: () => "9.9.9",
      filePath: () => controlFile,
      log: () => {},
    });
    registerContract(controlContract, controlHandlers, control.transport, {
      validateOutputs: true,
    });
    await control.start();
    track(() => control.stop());

    // ---- (2) The published file and the hello gate.
    const published = JSON.parse(readFileSync(controlFile, "utf8"));
    assert.equal(published.pid, process.pid);
    assert.equal(published.appVersion, "9.9.9");
    assert.equal(
      statSync(controlFile).mode & 0o077,
      0,
      "control.json must be owner-only: it carries the token",
    );
    const badHello = await rawExchange(published.port, [
      { t: "hello", token: "not-the-token" },
      { t: "req", id: 1, channel: "control:devices", input: {} },
    ]);
    assert.deepEqual(
      badHello.map((frame) => frame.t),
      ["refused"],
      "a bad token is refused and its request never answered",
    );
    const noHello = await rawExchange(published.port, [
      { t: "req", id: 1, channel: "control:devices", input: {} },
    ]);
    assert.deepEqual(
      noHello.map((frame) => frame.t),
      ["refused"],
      "a request before any hello is refused",
    );
    const offSurface = await rawExchange(published.port, [
      { t: "hello", token: published.token },
      { t: "req", id: 7, channel: "worktrees:delete", input: {} },
    ]);
    assert.equal(offSurface[0].t, "welcome");
    assert.equal(offSurface[1].ok, false);
    assert.match(offSurface[1].message, /No handler registered/);
    writeFileSync(
      controlFile,
      JSON.stringify({ ...published, token: "stale-token" }),
    );
    await refused(["devices"], "app-not-running");
    writeFileSync(controlFile, JSON.stringify(published));
    ok(
      "control.json is owner-only, a bad or missing hello is refused, only the control contract is served, and a stale token reads as app-not-running",
    );

    // ---- (2b) The listener's bounds, on a server of their own.
    await proveBounds(track);
    ok(
      "bounds: the hello deadline drops a silent connection only, the connection past the cap is refused as busy until one closes, the call past the in-flight cap is refused, an oversized line ends the connection, a close aborts its calls' signal, and stop() tears connections down before it returns",
    );

    // ---- (3) devices: standing per device for the repo.
    const devicesOf = async (...args) => finalDoc(await sm("devices", ...args));
    const ungranted = await devicesOf("-p", "source");
    assert.deepEqual(ungranted.thisDevice, {
      deviceId: "B",
      name: "Agent Box",
    });
    assert.deepEqual(
      ungranted.devices.map((device) => [device.name, device.block]),
      [
        ["Studio Mac", "no-grant"],
        ["Studio Laptop", "offline"],
      ],
      "the browser is left out, the away machine is offline, the peer is read-only",
    );
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source"],
      "device-blocked",
      /"Studio Mac" doesn't accept commands/,
    );
    listener.setAccepts(true);
    const granted = await devicesOf("-p", "source");
    assert.equal(granted.devices[0].block, undefined);
    assert.equal(granted.devices[0].projectId, targetProjectId);
    ok(
      "devices: names the peers, skips the browser, and reports offline, no-grant and ready for the repo",
    );

    // ---- (4) send: device resolution, then the transplant itself.
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source", "--to", "nobody"],
      "no-device",
      /No device is named "nobody"/,
    );
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source", "--to", "studio"],
      "ambiguous-device",
      /"Studio Mac", "Studio Laptop"/,
    );
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source", "--to", "Studio Laptop"],
      "device-blocked",
      /not connected/,
    );
    const usage = await runCli([
      "worktrees",
      "send",
      "wt-send",
      "-p",
      "source",
      "--source",
      "burn",
    ]);
    assert.equal(usage.code, 2, "a bad --source is a usage error");

    const sendRun = await sm("worktrees", "send", "wt-send", "-p", "source");
    const sent = finalDoc(sendRun);
    assert.equal(
      sent.device.name,
      "Studio Mac",
      "the only ready device is picked",
    );
    assert.equal(sent.worktree.branch, "feat-send");
    assert.equal(sent.captured, true);
    assert.equal(sent.dirtyApplied, true);
    assert.deepEqual(sent.source, { fate: "keep", done: true });
    assert.deepEqual(sent.caveats, []);
    assert.equal(
      readFileSync(join(sent.worktree.path, "s.txt"), "utf8"),
      "feat-send\n",
    );
    assert.equal(
      readFileSync(join(sent.worktree.path, "draft.txt"), "utf8"),
      "uncommitted\n",
      "the uncommitted work landed on the peer",
    );
    const steps = new Set(progressOf(sendRun).map((doc) => doc.step));
    for (const step of ["capture", "transfer", "create", "apply"]) {
      assert.ok(steps.has(step), `progress never reported the ${step} step`);
    }
    assert.equal(existsSync(sendPath), true, "--source keep leaves the source");
    await refused(
      ["worktrees", "send", "wt-send", "-p", "source", "--to", "Studio Mac"],
      // The peer's own refusal, passed through in its words, uncoded.
      undefined,
      /The other device answered: feat-send is already checked out/,
    );
    ok(
      "send: refuses an unknown, an ambiguous and an offline device by code, lands a dirty worktree on the only ready one with streamed progress, and passes the peer's refusal of a repeat through",
    );

    // ---- (5) send --source teardown, through the send's own receipt.
    const torn = finalDoc(
      await sm(
        "worktrees",
        "send",
        "wt-tear",
        "-p",
        "source",
        "--to",
        "A",
        "--source",
        "teardown",
      ),
    );
    assert.deepEqual(torn.source, { fate: "teardown", done: true });
    assert.equal(existsSync(tearPath), false, "the source is removed");
    assert.equal(existsSync(torn.worktree.path), true, "the copy stays");
    ok(
      "send --source teardown: the local source is removed once the copy holds it",
    );

    // ---- (6) bring: the list, then the pull, shelving the source.
    peerOwns = sourceProjectId;
    // list's own shape, an array of worktrees, each saying whose it is.
    const remoteList = async (...args) =>
      (await sm("worktrees", "list", "--remote", "-p", "target", ...args))
        .docs[0];
    const listing = await remoteList();
    assert.ok(Array.isArray(listing), "list --remote emits list's array");
    const peerRow = listing.find((wt) => wt.branch === "feat-peer");
    assert.ok(peerRow, `the remote list: ${listing.map((wt) => wt.branch)}`);
    assert.equal(peerRow.path, peerPath);
    assert.ok(listing.every((wt) => wt.device.name === "Studio Mac"));
    assert.ok(
      listing.every((wt) => !wt.isPrimary),
      "a primary checkout is nothing to bring",
    );
    assert.deepEqual(await remoteList("--from", "Studio Mac"), listing);
    // The away machine: said on stderr beside the list, and a refusal
    // when it is the one asked for.
    const withAway = await sm("worktrees", "list", "--remote", "-p", "target");
    assert.match(withAway.stderrTail, /"Studio Laptop" is not connected/);
    await refused(
      ["worktrees", "list", "--from", "Studio Laptop", "-p", "target"],
      "device-blocked",
      /not connected/,
    );
    const bare = await runCli(["worktrees", "bring", "-p", "target"]);
    assert.equal(bare.code, 2, "bring with no worktree is a usage error");
    assert.match(finalDoc(bare).error, /worktrees list --remote/);
    await refused(
      ["worktrees", "bring", "no-such-branch", "-p", "target"],
      "no-worktree",
      /No worktree "no-such-branch"/,
    );
    // The fixture worktree was made by plain git, outside the managed
    // layout, and the peer won't shelve an external worktree. The
    // bring still stands: it lands, exits 3, and says what didn't hold.
    const caveated = await runCli([
      "worktrees",
      "bring",
      "feat-peer",
      "-p",
      "target",
      "--source",
      "shelve",
    ]);
    assert.equal(caveated.code, 3, "a landed bring with a caveat exits 3");
    const brought = finalDoc(caveated);
    assert.equal(brought.ok, true);
    assert.equal(brought.worktree.projectId, targetProjectId);
    assert.equal(brought.captured, true);
    assert.equal(brought.dirtyApplied, true);
    assert.equal(brought.source.done, false);
    assert.match(brought.caveats[0], /the source was not shelved: External/);
    assert.equal(
      readFileSync(join(brought.worktree.path, "peer-draft.txt"), "utf8"),
      "peer uncommitted\n",
    );
    // A managed worktree on the peer, which it will shelve.
    const managed = finalDoc(
      await sm(
        "create",
        "-p",
        "source",
        "--no-setup",
        "--no-cd",
        "-b",
        "feat-managed",
        "--",
        "wt-managed",
      ),
    );
    assert.equal(managed?.ok ?? true, true);
    const shelved = finalDoc(
      await sm(
        "worktrees",
        "bring",
        "wt-managed",
        "-p",
        "target",
        "--from",
        "Studio Mac",
        "--source",
        "shelve",
      ),
    );
    assert.deepEqual(shelved.source, { fate: "shelve", done: true });
    assert.deepEqual(shelved.caveats, []);
    const peerList = await buildClient(worktreesContract, peerA.transport).list(
      {
        projectId: sourceProjectId,
      },
    );
    assert.equal(
      peerList.find((wt) => wt.name === "wt-managed")?.shelved,
      true,
      "the source was shelved over the wire",
    );
    assert.equal(
      peerList.find((wt) => wt.id === worktreeIdFromPath(peerPath))?.shelved,
      false,
    );
    ok(
      "list --remote names the peer's worktrees, and bring: points there when given none, refuses an unknown one by code, lands one by branch with its uncommitted work, exits 3 naming the source fate that didn't hold, and shelves a source the peer will shelve",
    );

    // ---- (6b) A bring whose CLI goes away mid-transfer. The chunk
    // requests are held at this device's side of the wire, so the
    // transfer has started on both ends when the control socket
    // closes. The temp dirs are made under a sandboxed TMPDIR for the
    // check, so what is left behind is exactly what the listing shows.
    await addWorktree(sourceRepo, "wt-depart", "feat-depart", "d.txt");
    const departTmp = join(sandbox, "depart-tmp");
    mkdirSync(departTmp);
    const tmpBefore = process.env.TMPDIR;
    process.env.TMPDIR = departTmp;
    const transferDirs = () =>
      readdirSync(departTmp).filter((name) => name.startsWith("sm-sync-"));
    const heldChunks = [];
    const syncOverWire = buildClient(syncContract, peerA.transport);
    await provide({
      peerApis: Layer.succeed(PeerApis, {
        syncApiFor: () => ({
          ...syncOverWire,
          bundleChunk: (input) =>
            new Promise((resolve, reject) => {
              heldChunks.push(() =>
                syncOverWire.bundleChunk(input).then(resolve, reject),
              );
            }),
        }),
        worktreesApiFor: () => buildClient(worktreesContract, peerA.transport),
      }),
    });
    try {
      const cli = await rawClient(published.port);
      cli.send({ t: "hello", token: published.token });
      await waitFor(() => cli.frames.length > 0, "a welcome");
      cli.send({
        t: "req",
        id: 1,
        channel: "control:bring",
        input: { projectId: targetProjectId, worktree: "feat-depart" },
      });
      await waitFor(
        () => heldChunks.length > 0,
        "the bring's first chunk request",
        30_000,
      );
      const started = transferDirs();
      assert.ok(
        started.some((name) => name.startsWith("sm-sync-recv-")) &&
          started.some((name) => !name.startsWith("sm-sync-recv-")),
        `the bring had not made both temp bundles: ${started.join(", ")}`,
      );
      cli.socket.destroy();
      await waitFor(
        () => transferDirs().length === 0,
        "the temp bundles to go with the departed CLI",
        1_000,
      );
      // The held chunks go through now: a bring that had only parked
      // would take them and land.
      for (const release of heldChunks.splice(0)) release();
      await delay(500);
      await git(targetRepo, [
        "rev-parse",
        "--verify",
        "-q",
        "refs/heads/feat-depart",
      ]).then(
        () => assert.fail("the departed bring landed its branch"),
        () => {},
      );
      await git(targetRepo, [
        "rev-parse",
        "--verify",
        "-q",
        "refs/shigomori/incoming/feat-depart",
      ]).then(
        () => assert.fail("the departed bring left its incoming ref"),
        () => {},
      );
    } finally {
      for (const release of heldChunks.splice(0)) release();
      process.env.TMPDIR = tmpBefore;
      if (tmpBefore === undefined) delete process.env.TMPDIR;
      await provide();
    }
    ok(
      "bring: a CLI that goes away mid-transfer leaves no temp bundle on either side within a second, lands nothing, and sweeps its incoming ref",
    );

    peerOwns = targetProjectId;

    // ---- (7) mirror / mirrors / unmirror, against the recording engine.
    const mirrored = finalDoc(
      await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
    );
    assert.equal(mirrored.device.name, "Studio Mac");
    assert.equal(typeof mirrored.session, "string");
    // The transplants above each ran the engine once for their ignored
    // files (host/mirror/oneShot.ts), under the transfer label.
    const mirrorsCreated = () =>
      engine.state.created.filter(
        (input) => !(MIRROR_LABEL_TRANSFER in input.labels),
      );
    assert.equal(mirrorsCreated().length, 1);
    const created = mirrorsCreated()[0];
    assert.equal(
      created.localRoot,
      mirrorPath,
      "the session runs on the original",
    );
    assert.equal(created.remoteRoot, mirrored.worktree.path);
    assert.equal(created.labels[MIRROR_LABEL_COPY_SIDE], "remote");
    assert.equal(existsSync(join(mirrored.worktree.path, "m.txt")), true);

    const again = finalDoc(
      await sm("worktrees", "mirror", "wt-mirror", "-p", "source"),
    );
    assert.equal(again.alreadyMirrored, true);
    assert.equal(again.session, mirrored.session);
    assert.equal(mirrored.copySide, "remote");
    assert.equal(again.copySide, "remote");
    assert.equal(mirrorsCreated().length, 1, "no second session is opened");

    const running = finalDoc(await sm("worktrees", "mirrors"));
    assert.equal(running.mirrors.length, 1);
    assert.equal(running.mirrors[0].copySide, "remote");
    assert.equal(running.mirrors[0].device.name, "Studio Mac");
    assert.equal(running.mirrors[0].localRoot, mirrorPath);

    await refused(
      ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
      "stop-unconfirmed",
      /pass -f to stop anyway/,
    );
    assert.equal(
      engine.state.terminated.includes(mirrored.session),
      false,
      "a refused stop ends nothing",
    );
    engine.state.git = "synced";
    const stopped = finalDoc(
      await sm("worktrees", "unmirror", "wt-mirror", "-p", "source"),
    );
    assert.equal(stopped.mirror.copySide, "remote");
    assert.equal(engine.state.terminated.includes(mirrored.session), true);
    assert.equal(
      existsSync(mirrored.worktree.path),
      false,
      "stopping removes the copy on the peer",
    );
    assert.equal(existsSync(mirrorPath), true, "and never the original");
    await refused(
      ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
      "no-mirror",
    );
    ok(
      "mirror: sends the worktree and opens a session whose copy is the peer's, a repeat answers with the running one, and unmirror is refused until synced, then removes only the copy",
    );

    // ---- (7b) mirror --from: the peer's worktree is copied HERE and
    // the session's copy side is this device, so unmirror removes the
    // local copy and leaves the peer's original.
    peerOwns = sourceProjectId;
    const usageBoth = await runCli([
      "worktrees",
      "mirror",
      "feat-in",
      "-p",
      "target",
      "--to",
      "A",
      "--from",
      "A",
    ]);
    assert.equal(usageBoth.code, 2, "--to with --from is a usage error");
    // An unset shell variable must not turn the bring into a send.
    const blankFrom = await runCli([
      "worktrees",
      "mirror",
      "feat-in",
      "-p",
      "target",
      "--from",
      "",
    ]);
    assert.equal(blankFrom.code, 2, "a blank --from is a usage error");
    const inbound = finalDoc(
      await sm(
        "worktrees",
        "mirror",
        "feat-in",
        "-p",
        "target",
        "--from",
        "Studio Mac",
      ),
    );
    assert.equal(inbound.worktree.projectId, targetProjectId);
    assert.equal(typeof inbound.session, "string");
    const inboundInput = mirrorsCreated().at(-1);
    assert.equal(inboundInput.localRoot, inbound.worktree.path);
    assert.equal(inboundInput.remoteRoot, inPath);
    assert.equal(inboundInput.labels[MIRROR_LABEL_COPY_SIDE], undefined);
    const inboundRow = finalDoc(await sm("worktrees", "mirrors")).mirrors.find(
      (mirror) => mirror.session === inbound.session,
    );
    assert.equal(inboundRow.copySide, "local");
    // Asked again from either end, the answer is the running mirror
    // and the copy that is HERE, never a second pull.
    const sessionsBefore = mirrorsCreated().length;
    const repeats = await Promise.all(
      [
        ["feat-in", "-p", "target", "--from", "Studio Mac"],
        [inbound.worktree.path],
      ].map((repeat) => sm("worktrees", "mirror", ...repeat)),
    );
    for (const asked of repeats.map(finalDoc)) {
      assert.equal(asked.alreadyMirrored, true);
      assert.equal(asked.session, inbound.session);
      assert.equal(asked.copySide, "local");
      assert.equal(asked.worktree.path, inbound.worktree.path);
    }
    assert.equal(mirrorsCreated().length, sessionsBefore);
    const inboundStop = finalDoc(
      await sm("worktrees", "unmirror", inbound.worktree.path),
    );
    assert.equal(inboundStop.mirror.copySide, "local");
    assert.equal(
      existsSync(inbound.worktree.path),
      false,
      "stopping removes the copy here",
    );
    assert.equal(existsSync(inPath), true, "and never the peer's original");
    peerOwns = targetProjectId;
    ok(
      "mirror --from: the peer's worktree is copied here under a session whose copy is local, a repeat from either end answers with that copy, --to with --from and a blank --from are refused as usage, and unmirror removes the local copy only",
    );

    // ---- (8) The peer going away mid-life reads as offline, not as a hang.
    connected = [];
    await refused(
      ["worktrees", "send", "wt-mirror", "-p", "source"],
      "device-blocked",
      /not connected/,
    );
    ok("a peer with no session is reported offline");

    // ---- (8b) Typed errors on the control wire. The CLI keys on the
    // top-level code, so a ControlError must keep it there whatever else
    // rides; and the typed `error` field beside the message is additive,
    // so the Go reader must ignore it and still print the message.
    const devicesRes = async () =>
      (
        await rawExchange(published.port, [
          { t: "hello", token: published.token },
          { t: "req", id: 1, channel: "control:devices", input: {} },
        ])
      )[1];
    await provide({
      control: Layer.succeed(ControlReach, {
        ...controlImpl,
        thisDeviceId: () => "nobody-here",
      }),
    });
    const signedOut = await devicesRes();
    assert.equal(signedOut.ok, false);
    assert.equal(signedOut.code, "signed-out", "the code left the top level");
    assert.match(signedOut.message, /isn't signed in/);
    // A ControlError is a tagged error, so it also rides the typed form,
    // its code a field of it.
    assert.deepEqual(signedOut.error, {
      _tag: "ControlError",
      code: "signed-out",
      message: signedOut.message,
    });
    await refused(["devices"], "signed-out", /isn't signed in/);
    await provide({
      control: Layer.succeed(ControlReach, {
        ...controlImpl,
        listDevices: async () => {
          throw unknownWorktreeError("wt-gone");
        },
      }),
    });
    const gone = await devicesRes();
    assert.equal(gone.ok, false);
    assert.equal(gone.message, "Unknown worktree: wt-gone");
    assert.equal("code" in gone, false, "an uncoded error grew a code");
    assert.deepEqual(gone.error, {
      _tag: "UnknownWorktree",
      worktreeId: "wt-gone",
      message: "Unknown worktree: wt-gone",
    });
    await refused(["devices"], undefined, /Unknown worktree: wt-gone/);
    await provide();
    ok(
      "typed errors: a ControlError keeps its code on the top-level res, and a tagged error's additive error field reaches the real CLI, which still prints the message",
    );

    // ---- (9) A data wipe takes control.json with the rest of the data
    // dir while the app lives on. The wipe's last step puts it back.
    rmSync(controlFile);
    control.republish();
    assert.deepEqual(JSON.parse(readFileSync(controlFile, "utf8")), published);
    finalDoc(await sm("worktrees", "mirrors"));
    ok("a control.json removed under the running app is republished");

    // ---- (10) Stop unpublishes, and the CLI reads that as not running.
    control.stop();
    assert.equal(existsSync(controlFile), false, "stop removes control.json");
    await refused(["worktrees", "mirrors"], "app-not-running");
    ok("stopping the server unpublishes it");
  } finally {
    await teardown();
    resetHostRuntime();
    await installed?.dispose();
  }

  done();
}

main()
  .catch(fail)
  .finally(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });
