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
//   - `mirror` sends the worktree and opens a session labelled with
//     the copy on the peer, a second `mirror` answers with the running
//     one, and `unmirror` is refused until the follower reports synced
//     (stop-unconfirmed), then removes the peer's copy.
//   - `mirror --from` is refused while this device refuses commands,
//     then asks the peer to run the mirror (its mirror:startTo, on its
//     own engine) and send the copy here, relaying its progress. The
//     copy is local, a repeat from either end answers with it, and
//     `unmirror` removes it through the peer, original kept.
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
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { buildClient } from "@shared/ipc/buildClient";
import { controlContract } from "@shared/ipc/modules/control";
import {
  MIRROR_LABEL_COPY_SIDE,
  MIRROR_LABEL_MIRROR_BRANCH,
  MIRROR_LABEL_TRANSFER,
  mirrorContract,
} from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { registerContract } from "@shared/ipc/registerContract";
import { controlHandlers, setControlImpl } from "@host/ipc/modules/control";
import { mirrorHandlers, setMirrorImpl } from "@host/ipc/modules/mirror";
import { projectsHandlers } from "@host/ipc/modules/projects";
import { syncHandlers } from "@host/ipc/modules/sync";
import {
  setWorktreeRemovalBroadcaster,
  worktreesHandlers,
} from "@host/ipc/modules/worktrees";
import { setPeerSyncApiImpl } from "@host/ipc/peerSync";
import { worktreeIdFromPath } from "@host/lib/git/worktrees";
import {
  CONTROL_FILE_NAME,
  createControlServer,
} from "../main/core/control/server.ts";
import { makeProof, makeTracker } from "./lib/checkKit.mjs";
import { cliSandbox } from "./lib/cliSandbox.mjs";
import { bootDirectWire } from "./lib/directBoot.mjs";

const fixture = cliSandbox("sm-control-check-");
const { sandbox, dataDir, git, gitOut, runCli, sm } = fixture;
const { addWorktree, projectIdOf } = fixture;
const controlFile = join(dataDir, CONTROL_FILE_NAME);

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

// One row of the account's device registry, as the hub lists it.
const registered = (deviceId, name, platform = "darwin") => ({
  deviceId,
  name,
  platform,
  icon: "laptop",
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

  await fixture.buildSm();

  // Source repo (this device, B) and its clone (the peer, A), one repo
  // identity between them.
  const sourceRepo = join(sandbox, "source");
  await git(sandbox, ["init", "-q", "-b", "main", "source"]);
  await fixture.disableAutoGc(sourceRepo);
  await fixture.commitFile(sourceRepo, "readme.txt", "base\n", "base");
  const targetRepo = join(sandbox, "target");
  await git(sandbox, ["clone", "-q", "--", sourceRepo, "target"]);
  await fixture.disableAutoGc(targetRepo);
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

  fixture.useCli();
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
    // Each device's mirror engine. B's is the slot's own. The peer
    // runs the mirrors whose original it holds (mirror --from), on its
    // own engine: the slot is process-wide, so a mirror call on A's
    // wire swaps A's in for its duration. The calls come one at a
    // time (each CLI run is awaited), B's side idle meanwhile.
    const engine = fakeMirrorEngine();
    const engineA = fakeMirrorEngine();
    engineA.state.git = "synced";
    setMirrorImpl(engine.impl);
    const asA = (run) => (input, ctx) => {
      setMirrorImpl(engineA.impl);
      let result;
      try {
        result = run(input, ctx);
      } catch (error) {
        setMirrorImpl(engine.impl);
        throw error;
      }
      if (!(result instanceof Promise)) {
        setMirrorImpl(engine.impl);
        return result;
      }
      return result.finally(() => setMirrorImpl(engine.impl));
    };
    const mirrorOnA = Object.fromEntries(
      Object.entries(mirrorHandlers).map(([key, run]) => [key, asA(run)]),
    );
    const { listener, peerA } = await bootDirectWire(track, {
      contracts: [
        [syncContract, syncHandlers],
        [worktreesContract, worktreesHandlers],
        [projectsContract, projectsHandlers],
        [mirrorContract, mirrorOnA],
      ],
    });
    setPeerSyncApiImpl({
      // The sync surface and the session's byte channels, which a
      // move's source link rides.
      syncApiFor: () => ({
        ...buildClient(syncContract, peerA.transport),
        channels: peerA.channels,
      }),
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
    // This device's own switch, which a mirror --from needs on.
    let localAccepts = true;
    setControlImpl({
      listDevices: async () => registry,
      thisDeviceId: () => "B",
      acceptsCommands: () => localAccepts,
      directPeers: async () =>
        Object.fromEntries(
          connected.map((id) => [id, listener.acceptsCommands()]),
        ),
      peerTransportFor: () => peerTransport,
    });
    // The delete's removal, as main fans it out to every window and
    // peer. Each record notes which sessions had ended by then: the
    // copy a stop removes is announced only once its session is gone,
    // since the delete follows the terminate.
    const removals = [];
    setWorktreeRemovalBroadcaster((payload) =>
      removals.push({
        ...payload,
        endedThen: [...engine.state.terminated, ...engineA.state.terminated],
      }),
    );
    const removalsOf = (worktreeId) =>
      removals.filter((entry) => entry.worktreeId === worktreeId);

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
    // The peer's primary checkout is listed (a mirror of it lands on
    // mirror/<branch> here), and a bring of it is refused by name.
    const primaryRow = listing.find((wt) => wt.isPrimary);
    assert.ok(primaryRow, "the remote list names the peer's primary checkout");
    assert.equal(primaryRow.branch, "main");
    assert.deepEqual(await remoteList("--from", "Studio Mac"), listing);
    await refused(
      ["worktrees", "bring", primaryRow.name, "-p", "target"],
      "no-worktree",
      /primary checkout, which can be mirrored but not brought/,
    );
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
    assert.deepEqual(
      removalsOf(mirrored.worktree.id).map((entry) => entry.state),
      ["removing", "removed"],
      "the peer announces the copy's removal, and that it is gone",
    );
    await refused(
      ["worktrees", "unmirror", "wt-mirror", "-p", "source"],
      "no-mirror",
    );
    ok(
      "mirror: sends the worktree and opens a session whose copy is the peer's, a repeat answers with the running one, and unmirror is refused until synced, then removes only the copy",
    );

    // ---- (7b) mirror --from: the peer holds the original, so the peer
    // runs the mirror (its mirror:startTo, on its own engine) and sends
    // the copy HERE, which lands through this device's command access.
    // unmirror removes the local copy through the peer and leaves the
    // peer's original.
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
    // The peer would send the copy through this device's switch, so
    // with it off the ask is refused before the peer hears of it.
    localAccepts = false;
    await refused(
      [
        "worktrees",
        "mirror",
        "feat-in",
        "-p",
        "target",
        "--from",
        "Studio Mac",
      ],
      "device-blocked",
      /this device doesn't accept commands/,
    );
    assert.equal(engineA.state.created.length, 0, "the peer started nothing");
    localAccepts = true;
    const createdHereBefore = mirrorsCreated().length;
    const inboundRun = await sm(
      "worktrees",
      "mirror",
      "feat-in",
      "-p",
      "target",
      "--from",
      "Studio Mac",
    );
    const inbound = finalDoc(inboundRun);
    assert.equal(inbound.worktree.projectId, targetProjectId);
    assert.equal(inbound.copySide, "local");
    assert.equal(typeof inbound.session, "string");
    assert.equal(
      mirrorsCreated().length,
      createdHereBefore,
      "the session runs on the peer, not here",
    );
    const inboundInput = engineA.state.created.at(-1);
    assert.equal(inboundInput.localRoot, inPath, "on the original");
    assert.equal(inboundInput.deviceId, "B");
    assert.equal(inboundInput.remoteRoot, inbound.worktree.path);
    assert.equal(inboundInput.labels[MIRROR_LABEL_COPY_SIDE], "remote");
    const inboundSteps = new Set(progressOf(inboundRun).map((doc) => doc.step));
    for (const step of ["capture", "create", "apply"]) {
      assert.ok(
        inboundSteps.has(step),
        `the peer's progress never relayed the ${step} step`,
      );
    }
    const inboundRow = finalDoc(await sm("worktrees", "mirrors")).mirrors.find(
      (mirror) => mirror.session === inbound.session,
    );
    assert.equal(inboundRow.copySide, "local");
    assert.equal(inboundRow.device.name, "Studio Mac");
    // Asked again from either end, the answer is the running mirror
    // and the copy that is HERE, never a second start.
    const sessionsBefore = engineA.state.created.length;
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
    assert.equal(engineA.state.created.length, sessionsBefore);
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
    const inboundRemovals = removalsOf(inbound.worktree.id);
    assert.deepEqual(
      inboundRemovals.map((entry) => entry.state),
      ["removing", "removed"],
      "the local copy's removal is announced, and that it is gone",
    );
    assert.equal(inboundRemovals[0].projectId, targetProjectId);
    assert.ok(
      inboundRemovals[0].endedThen.includes(inbound.session),
      "announced after the session ended: the delete follows the terminate",
    );
    ok(
      "mirror --from: refused while this device refuses commands, then run by the peer on the original with its progress relayed, the copy local, a repeat from either end answers with that copy, --to with --from and a blank --from are refused as usage, and unmirror removes the local copy only",
    );

    // ---- (7c) mirror --from of the peer's primary checkout: the copy
    // lands as a worktree on mirror/main in a mirror- folder, the
    // session is labelled for the follower, and the peer's primary
    // stays. Named by its folder, as list --remote shows it.
    const primaryMainBefore = await gitOut(sourceRepo, "rev-parse", "HEAD");
    const fromPrimary = finalDoc(
      await sm(
        "worktrees",
        "mirror",
        "source",
        "-p",
        "target",
        "--from",
        "Studio Mac",
      ),
    );
    assert.equal(fromPrimary.worktree.projectId, targetProjectId);
    assert.equal(fromPrimary.worktree.branch, "mirror/main");
    assert.equal(fromPrimary.worktree.name, "mirror-source");
    assert.equal(fromPrimary.worktree.isPrimary, false);
    assert.equal(fromPrimary.copySide, "local");
    const fromPrimaryInput = engineA.state.created.at(-1);
    assert.equal(fromPrimaryInput.localRoot, sourceRepo);
    assert.equal(fromPrimaryInput.remoteRoot, fromPrimary.worktree.path);
    assert.equal(fromPrimaryInput.labels[MIRROR_LABEL_MIRROR_BRANCH], "1");
    assert.equal(
      await gitOut(fromPrimary.worktree.path, "rev-parse", "HEAD"),
      primaryMainBefore,
    );
    const fromPrimaryStop = finalDoc(
      await sm("worktrees", "unmirror", fromPrimary.worktree.path),
    );
    assert.equal(fromPrimaryStop.mirror.copySide, "local");
    assert.equal(existsSync(fromPrimary.worktree.path), false);
    assert.equal(
      await gitOut(sourceRepo, "rev-parse", "HEAD"),
      primaryMainBefore,
    );
    assert.equal(
      await gitOut(sourceRepo, "symbolic-ref", "HEAD"),
      "refs/heads/main",
      "the peer's primary must stay on its branch",
    );
    peerOwns = targetProjectId;
    ok(
      "mirror --from of the peer's primary: lands as a worktree on mirror/main in mirror-<name>, labelled for the follower, and unmirror removes the copy with the peer's primary untouched",
    );

    // ---- (8) The peer going away mid-life reads as offline, not as a hang.
    connected = [];
    await refused(
      ["worktrees", "send", "wt-mirror", "-p", "source"],
      "device-blocked",
      /not connected/,
    );
    ok("a peer with no session is reported offline");

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
  }

  done();
}

main().catch(fail).finally(fixture.remove);
