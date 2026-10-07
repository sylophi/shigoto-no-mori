// Durable proof for how the mirror daemon's supervisor
// (main/core/mirror/daemon.ts) reads the engine's NDJSON lines
// (file-sync/engine.go, the daemon control protocol). The child is a
// fake stream the proof writes the daemon's side of, so each line is
// exactly the one under test, no engine built.
//
// Asserts:
//   - a well-formed state line replaces the sessions, and a response
//     settles the request it names,
//   - a state line that breaks the contract (a field missing, a
//     sessions list that is not one) is dropped and logged, the last
//     good snapshot standing and the bridge reading the next line,
//   - a repeat of the same rejection logs once, the responses in
//     between not resetting it, and a good line of its kind does,
//   - a key the protocol does not name, on a line or on a session, is
//     stripped and the line read, and an event it does not name is
//     ignored, so what a newer engine adds cannot stop the stream or
//     fail a request,
//   - a malformed response settles its request with an error rather
//     than resolving with what it carried,
//   - the engine's id-less refusal (an empty id) is logged, not dropped.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test mirror-daemon-lines.
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { StreamChild } from "@host/fileSync/spawn";
import { lineSplitter } from "@host/lib/util/ndjson";
import { createMirrorDaemon } from "../main/core/mirror/daemon.ts";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("mirror-daemon-lines proof");
console.log("mirror-daemon-lines proof\n");

const endpoint = {
  connected: true,
  scanned: true,
  directories: 1,
  files: 2,
  symbolicLinks: 0,
  totalFileSize: 10,
  problems: [],
  excludedProblems: 0,
};

// One session the way mirrorSessionStateOf writes it.
function session(id: string) {
  return {
    session: id,
    name: "mirror-w",
    labels: { localProjectId: "p", localWorktreeId: "w" },
    localRoot: "/a",
    deviceId: "B",
    projectId: "p",
    worktreeId: "w",
    remoteRoot: "/b",
    paused: false,
    ignores: [],
    createdAt: 1,
    status: "watching",
    statusText: "Watching for changes",
    successfulCycles: 3,
    conflicts: [],
    excludedConflicts: 0,
    local: endpoint,
    remote: endpoint,
  };
}

// A daemon on a fake child: `send` writes a line from the engine's
// side, `requests` collects what the supervisor wrote to it.
function harness() {
  const requests: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const split = lineSplitter((line) => requests.push(JSON.parse(line)));
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      split(chunk);
      callback();
    },
  });
  const child: StreamChild = {
    stream,
    stderr: null,
    pid: undefined,
    kill: () => {},
    onExit: () => {},
  };
  const daemon = createMirrorDaemon({
    spawn: () => child,
    gatewayAddress: () => "127.0.0.1:1",
    gatewayToken: () => "token",
    dataDir: () => "unused",
    log: (message) => logs.push(message),
  });
  daemon.start();
  const send = async (line: unknown) => {
    stream.push(JSON.stringify(line) + "\n");
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { daemon, send, requests, logs };
}

try {
  await proof.check(
    "a well-formed state line is the sessions",
    async (track) => {
      const { daemon, send } = harness();
      track(() => daemon.stop());
      await send({ event: "ready" });
      assert.equal(daemon.status(), "running");
      await send({ event: "state", sessions: [session("s1")] });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s1"],
      );
    },
  );

  await proof.check(
    "a state line off the contract is dropped and logged",
    async (track) => {
      const { daemon, send, logs } = harness();
      track(() => daemon.stop());
      await send({ event: "ready" });
      await send({ event: "state", sessions: [session("s1")] });
      const { labels: _labels, ...unlabelled } = session("s2");
      await send({ event: "state", sessions: [unlabelled] });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s1"],
        "a session without labels replaced the snapshot",
      );
      assert.equal(logs.length, 1, logs.join("\n"));
      assert.match(logs[0] ?? "", /labels/);
      await send({ event: "state", sessions: "s2" });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s1"],
        "a sessions field that is not a list emptied the snapshot",
      );
      await send({ event: "state", sessions: [session("s3")] });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s3"],
        "the bridge stopped reading after a bad line",
      );
    },
  );

  await proof.check("a repeated rejection logs once", async (track) => {
    const { daemon, send, requests, logs } = harness();
    track(() => daemon.stop());
    await send({ event: "ready" });
    const bad = { event: "state", sessions: [{ ...session("s1"), status: 7 }] };
    await send(bad);
    const paused = daemon.pause("s1");
    await send({ id: requests.at(-1)?.["id"], ok: true, session: "s1" });
    await paused;
    await send(bad);
    assert.equal(logs.length, 1, logs.join("\n"));
    await send({ event: "state", sessions: [] });
    await send(bad);
    assert.equal(logs.length, 2, "a rejection after a good line logs again");
  });

  await proof.check(
    "what the protocol does not name is stripped or ignored, not refused",
    async (track) => {
      const { daemon, send, requests, logs } = harness();
      track(() => daemon.stop());
      await send({ event: "ready", version: 2 });
      assert.equal(daemon.status(), "running");
      await send({
        event: "state",
        sessions: [{ ...session("s1"), newField: true }],
        index: 9,
      });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s1"],
      );
      assert.equal("newField" in (daemon.sessions()[0] ?? {}), false);
      const paused = daemon.pause("s1");
      await send({
        id: requests.at(-1)?.["id"],
        ok: true,
        session: "s1",
        took: 3,
      });
      assert.equal(await paused, "s1");
      await send({ event: "progress", session: "s1", files: 3 });
      assert.deepEqual(
        daemon.sessions().map((raw) => raw.session),
        ["s1"],
      );
      assert.deepEqual(logs, []);
    },
  );

  await proof.check(
    "a response settles its request, a malformed one with an error",
    async (track) => {
      const { daemon, send, requests, logs } = harness();
      track(() => daemon.stop());
      await send({ event: "ready" });
      const good = daemon.pause("s1");
      await send({ id: requests.at(-1)?.["id"], ok: true, session: "s1" });
      assert.equal(await good, "s1");
      const bad = assert.rejects(daemon.resume("s1"), /malformed/);
      await send({ id: requests.at(-1)?.["id"], ok: true, session: 42 });
      await bad;
      assert.equal(logs.length, 1, logs.join("\n"));
    },
  );

  await proof.check("an id-less refusal is logged", async (track) => {
    const { daemon, send, logs } = harness();
    track(() => daemon.stop());
    await send({ event: "ready" });
    await send({ id: "", ok: false, error: "malformed request: x" });
    assert.equal(logs.length, 1, "the refusal went unreported");
    assert.match(logs[0] ?? "", /malformed request: x/);
  });

  proof.done();
} catch (error) {
  proof.fail(error);
}
