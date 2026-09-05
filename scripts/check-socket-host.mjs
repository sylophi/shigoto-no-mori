// Durable proof for the websocket host binding (host/socket/server.ts).
// Starts a real binding on an ephemeral loopback port and drives a real
// ws client against it, asserting the auth, dispatch, broadcast and
// framing paths PLUS the security behaviors the hardening added:
// terminate-on-bad-token, post-timeout hello rejection, oversized-frame
// rejection, the Origin gate (the app's own renderer origins pass and
// reach welcome, a foreign web origin is refused), empty-token start
// refusal, the no-handler answer a non-remote channel gets, the
// per-socket in-flight cap, the stopped-listener generation guard, and
// the contract invariant that every host invoke is explicitly tagged
// remote true or false.
//
// The LAN read-only gate: the LAN wire serves
// ONLY channels explicitly registered mutating:false, refusing a
// mutating or untagged channel with the shared command-refused code
// BEFORE its handler runs. The client transport maps that code to the
// typed CommandRefusedError, the preflight remoteAccess:commandAccess
// answers granted:false over this wire, and the contract spot-checks
// pin the step-6 flips (fs, the projects and packageScripts preference
// writes, globalConfig.writeDeviceSettings with its strict patch schema
// that structurally rejects socketHost and any unmanaged key).
//
// The golden read surface: every channel servable ungated (remote:true,
// mutating:false) is pinned in read-surface.golden.json, so flipping a
// mutating tag shows up as a reviewed diff instead of silently opening
// or closing the ungated wire. Regenerate deliberately with
// `pnpm socket:check --update`.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "socket:check".
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_GOING_AWAY,
  CLOSE_HELLO_FAILED,
  COMMAND_REFUSED_CODE,
  CommandRefusedError,
  encodeFrame,
  MAX_IN_FLIGHT_PER_PEER,
} from "@shared/ipc/socket/frames";
import { connectDevice } from "@shared/ipc/socket/wsClientTransport";
import { rendererSchemeOrigins } from "@shared/rendererScheme.mts";
import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { registerContract } from "@shared/ipc/registerContract";
import { createWsServerBinding } from "@host/socket/server";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import { remoteAccessHandlers } from "@host/ipc/modules/remoteAccess";
// The authoritative contract registry (the same source check-host-boundary
// rule 6 derives from), so the explicit-remote-tag invariant covers every
// host module automatically instead of a hand-maintained list a new module
// could silently skip.
import { allContractModules } from "@shared/ipc/client";
// Contract modules referenced by the explicit spot-checks below.
import { cliContract } from "@shared/ipc/modules/cli";
import { forwardContract } from "@shared/ipc/modules/forward";
import { mirrorContract } from "@shared/ipc/modules/mirror";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { projectsContract } from "@shared/ipc/modules/projects";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { syncContract } from "@shared/ipc/modules/sync";
import { worktreesContract } from "@shared/ipc/modules/worktrees";
import { delay, makeProof, waitFor } from "./lib/checkKit.mjs";

const TOKEN = "correct-horse-battery-staple-token-of-good-length";
const WS_CLOSE_TOO_BIG = 1009;

// Shared handler state referenced by registerTestHandlers. Reset by the
// tests that use it.
let hangResolvers = [];
let countExecutions = 0;
let mutateExecutions = 0;
let untaggedExecutions = 0;

function registerTestHandlers(binding) {
  // The generic-path handlers are EXPLICIT reads (mutating:false): the
  // LAN gate is fail-closed and serves only channels proven read-only,
  // so tagging them keeps the dispatch/framing/broadcast tests serving
  // as before.
  binding.handle("test:echo", async (_ctx, raw) => raw, { mutating: false });
  binding.handle(
    "test:hang",
    () => new Promise((resolve) => hangResolvers.push(resolve)),
    { mutating: false },
  );
  binding.handle(
    "test:count",
    async () => {
      countExecutions += 1;
    },
    { mutating: false },
  );
  // A read-classified handler that throws, so the typed-error test can
  // prove a REAL failure stays a plain Error rather than the refusal
  // type.
  binding.handle(
    "test:fail",
    async () => {
      throw new Error("boom");
    },
    { mutating: false },
  );
  // A mutating handler and an untagged one, each with an execution
  // counter, so the gate tests can prove the handler body never ran on
  // a refusal.
  binding.handle(
    "test:mutate",
    async () => {
      mutateExecutions += 1;
      return "mutated";
    },
    { mutating: true },
  );
  binding.handle("test:untagged", async () => {
    untaggedExecutions += 1;
    return "ran";
  });
}

async function startBinding(overrides = {}) {
  const binding = createWsServerBinding();
  registerTestHandlers(binding);
  const port = await binding.start({
    port: 0,
    bindAddress: "127.0.0.1",
    token: TOKEN,
    deviceId: "host-device",
    appVersion: "9.9.9",
    helloTimeoutMs: 300,
    ...overrides,
  });
  return { binding, url: `ws://127.0.0.1:${port}` };
}

function connect(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const frames = [];
  const frameWaiters = [];
  let closed = null;
  const closeWaiters = [];
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString("utf8"));
    const waiter = frameWaiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  ws.on("close", (code, reason) => {
    closed = { code, reason: reason.toString("utf8") };
    for (const waiter of closeWaiters.splice(0)) waiter(closed);
  });
  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    }),
    send: (frame) => ws.send(encodeFrame(frame)),
    sendText: (text) => ws.send(text),
    pending: () => frames.length,
    nextFrame: () =>
      new Promise((resolve) => {
        const frame = frames.shift();
        if (frame) resolve(frame);
        else frameWaiters.push(resolve);
      }),
    waitClose: () =>
      new Promise((resolve) => {
        if (closed) resolve(closed);
        else closeWaiters.push(resolve);
      }),
    close: () => ws.close(),
  };
}

async function authenticate(url, token = TOKEN) {
  const client = connect(url);
  await client.opened;
  client.send({ t: "hello", token, deviceId: "client", appVersion: "1" });
  const welcome = await client.nextFrame();
  assert.equal(
    welcome.t,
    "welcome",
    "expected a welcome frame after a valid hello",
  );
  return { client, welcome };
}

const { check, done, fail } = makeProof("socket-host proof");

async function main() {
  console.log("socket-host security proof\n");

  await check(
    "auth handshake: a valid token gets a welcome carrying host identity",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client, welcome } = await authenticate(url);
        assert.equal(welcome.deviceId, "host-device");
        assert.equal(welcome.appVersion, "9.9.9");
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "dispatch: a req gets a matching res echoing the handler result",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        client.send({
          t: "req",
          id: 7,
          channel: "test:echo",
          input: { hi: 1 },
        });
        const res = await client.nextFrame();
        assert.equal(res.t, "res");
        assert.equal(res.id, 7);
        assert.equal(res.ok, true);
        assert.deepEqual(res.result, { hi: 1 });
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "framing: a void input round-trips as an absent field",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        client.send({ t: "req", id: 1, channel: "test:echo" });
        const res = await client.nextFrame();
        assert.equal(res.ok, true);
        assert.equal(res.result, undefined);
        assert.equal("result" in res, false);
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "broadcast: broadcastAll pushes a frame to an authed socket",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        binding.broadcastAll("test:ping", { n: 5 });
        const push = await client.nextFrame();
        assert.equal(push.t, "push");
        assert.equal(push.channel, "test:ping");
        assert.deepEqual(push.payload, { n: 5 });
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "terminate on bad token: a wrong token closes CLOSE_AUTH_FAILED and no later frame is processed",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const client = connect(url);
        await client.opened;
        client.send({
          t: "hello",
          token: "wrong",
          deviceId: "c",
          appVersion: "1",
        });
        // A req riding right behind the bad hello must never be answered.
        client.send({ t: "req", id: 42, channel: "test:echo", input: 1 });
        const close = await client.waitClose();
        assert.equal(close.code, CLOSE_AUTH_FAILED);
        assert.equal(
          client.pending(),
          0,
          "a frame after the rejected hello was processed",
        );
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "post-timeout hello: a hello after the hello timeout cannot authenticate",
    async () => {
      const { binding, url } = await startBinding({ helloTimeoutMs: 100 });
      try {
        const client = connect(url);
        await client.opened;
        await delay(250);
        // The timeout already fired. A late (correct) hello must not auth.
        client.send({
          t: "hello",
          token: TOKEN,
          deviceId: "c",
          appVersion: "1",
        });
        const close = await client.waitClose();
        assert.equal(close.code, CLOSE_HELLO_FAILED);
        assert.equal(
          client.pending(),
          0,
          "a welcome was sent after the hello timeout",
        );
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "non-remote channel: a host channel the ws binding never registered gets a no-handler res",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        // runtime:nuke is a real host channel tagged remote:false, so it
        // is never registered on this binding and can never execute.
        client.send({ t: "req", id: 3, channel: "runtime:nuke", input: {} });
        const res = await client.nextFrame();
        assert.equal(res.ok, false);
        assert.match(res.message, /No handler registered/);
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "oversized frame: an inbound frame over the 1 MiB cap closes the socket",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        const huge = "x".repeat((1 << 20) + 1024);
        client.send({ t: "req", id: 9, channel: "test:echo", input: huge });
        const close = await client.waitClose();
        assert.equal(close.code, WS_CLOSE_TOO_BIG);
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "empty-token start: the binding refuses to open without a token",
    async () => {
      const binding = createWsServerBinding();
      await assert.rejects(
        () =>
          binding.start({
            port: 0,
            bindAddress: "127.0.0.1",
            token: "",
            deviceId: "d",
            appVersion: "1",
          }),
        /empty token/,
      );
    },
  );

  await check(
    "Origin gate: the app's own renderer origins complete hello/welcome",
    async () => {
      // Browser-global WebSocket clients (the web client's hub path,
      // and any future in-app consumer of this listener) ALWAYS send
      // an Origin: the renderer-scheme origin from the app's own
      // window (both flavors), or a loopback http origin from a
      // locally served web client. All must be able to authenticate,
      // or an in-app client could never connect at all.
      const { binding, url } = await startBinding();
      const helloFrom = async (origin) => {
        const client = connect(url, { origin });
        await client.opened;
        client.send({
          t: "hello",
          token: TOKEN,
          deviceId: "client",
          appVersion: "1",
        });
        const welcome = await client.nextFrame();
        assert.equal(
          welcome.t,
          "welcome",
          `no welcome for a hello from origin ${origin}`,
        );
        client.close();
      };
      try {
        for (const origin of rendererSchemeOrigins()) {
          // oxlint-disable-next-line no-await-in-loop -- one shared binding, sequential hellos
          await helloFrom(origin);
        }
        await helloFrom("http://localhost:5173");
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "Origin gate: a handshake from a foreign web origin is rejected",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const client = connect(url, { origin: "https://evil.example" });
        await assert.rejects(client.opened);
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "in-flight cap: one request past the shared per-peer cap is refused rather than dispatched",
    async () => {
      hangResolvers = [];
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        // Fill the shared per-socket cap with requests that never
        // resolve, then send one more.
        for (let id = 1; id <= MAX_IN_FLIGHT_PER_PEER; id += 1) {
          client.send({ t: "req", id, channel: "test:hang", input: undefined });
        }
        client.send({
          t: "req",
          id: MAX_IN_FLIGHT_PER_PEER + 1,
          channel: "test:hang",
          input: undefined,
        });
        const res = await client.nextFrame();
        assert.equal(res.id, MAX_IN_FLIGHT_PER_PEER + 1);
        assert.equal(res.ok, false);
        assert.match(res.message, /too many in-flight/);
        // Release the held requests so shutdown is quick.
        for (const resolve of hangResolvers) resolve("done");
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "generation guard: no handler executes under a stopped listener",
    async () => {
      countExecutions = 0;
      const { binding, url } = await startBinding({ helloTimeoutMs: 2000 });
      const { client } = await authenticate(url);
      // stopNow drops the listener synchronously, so requests arriving
      // during the terminate grace window fail the generation guard.
      const stopping = binding.stop();
      for (let id = 0; id < 3; id += 1) {
        client.send({ t: "req", id, channel: "test:count", input: undefined });
      }
      await delay(300);
      assert.equal(
        countExecutions,
        0,
        "a handler executed under a stopped listener",
      );
      client.close();
      await stopping;
    },
  );

  await check(
    "LAN read-only gate: a mutating channel is refused with the typed code and its handler never runs, an untagged channel is refused fail-closed, and a read-only channel is still served",
    async () => {
      mutateExecutions = 0;
      untaggedExecutions = 0;
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        // (a) mutating:true is refused with the machine-readable code
        // and the handler body never runs.
        client.send({ t: "req", id: 1, channel: "test:mutate" });
        const mutateRes = await client.nextFrame();
        assert.equal(mutateRes.ok, false);
        assert.equal(mutateRes.code, COMMAND_REFUSED_CODE);
        assert.match(mutateRes.message, /not permitted to run commands/);
        assert.equal(
          mutateExecutions,
          0,
          "a mutating handler ran over the LAN wire",
        );
        // (b) an UNTAGGED channel is refused too: the gate serves only
        // channels proven read-only, so unclassified defaults closed.
        client.send({ t: "req", id: 2, channel: "test:untagged" });
        const untaggedRes = await client.nextFrame();
        assert.equal(untaggedRes.ok, false);
        assert.equal(untaggedRes.code, COMMAND_REFUSED_CODE);
        assert.equal(
          untaggedExecutions,
          0,
          "an untagged handler ran over the LAN wire",
        );
        // (c) an explicit read on the same socket is served as before.
        client.send({ t: "req", id: 3, channel: "test:echo", input: "read" });
        const echoRes = await client.nextFrame();
        assert.equal(echoRes.ok, true);
        assert.equal(echoRes.result, "read");
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "LAN typed refusal client-side: the socket client transport maps the code to CommandRefusedError while a real handler failure stays a plain Error",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const connection = await connectDevice({
          url,
          token: TOKEN,
          appVersion: "1",
          localDeviceId: "client",
          onClose: () => {},
        });
        await assert.rejects(
          () => connection.transport.invoke("test:mutate", undefined),
          (error) =>
            error instanceof CommandRefusedError &&
            /not permitted to run commands/.test(error.message),
        );
        // A throwing read-only handler is a REAL failure: same wire,
        // plain Error, so the typed refusal stays distinguishable.
        await assert.rejects(
          () => connection.transport.invoke("test:fail", undefined),
          (error) =>
            error instanceof Error &&
            !(error instanceof CommandRefusedError) &&
            error.message === "boom",
        );
        connection.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "LAN preflight: remoteAccess:commandAccess answers granted:false over the read-only wire",
    async () => {
      const binding = createWsServerBinding();
      registerTestHandlers(binding);
      // The REAL contract and handler through the shared registrar, so
      // the mutating:false registration and the transport-supplied
      // verdict are the production path, not a test double.
      registerContract(remoteAccessContract, remoteAccessHandlers, binding, {
        validateOutputs: true,
      });
      const port = await binding.start({
        port: 0,
        bindAddress: "127.0.0.1",
        token: TOKEN,
        deviceId: "host-device",
        appVersion: "9.9.9",
        helloTimeoutMs: 300,
      });
      try {
        const { client } = await authenticate(`ws://127.0.0.1:${port}`);
        client.send({ t: "req", id: 1, channel: "remoteAccess:commandAccess" });
        const res = await client.nextFrame();
        assert.equal(res.ok, true, "the preflight read was not served");
        assert.deepEqual(res.result, { granted: false });
        client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "liveness: the host answers pings and kills a heartbeating peer that falls silent, but never judges a peer that never pinged",
    async () => {
      const { binding, url } = await startBinding({ livenessTimeoutMs: 200 });
      try {
        // A peer that pings once proves it heartbeats: it gets a pong,
        // and going silent past the timeout then ends its socket.
        const { client } = await authenticate(url);
        client.send({ t: "ping" });
        const pong = await client.nextFrame();
        assert.equal(pong.t, "pong", "a ping must be answered with a pong");
        const closed = await client.waitClose();
        assert.equal(
          closed.code,
          CLOSE_GOING_AWAY,
          "a silent heartbeating peer must be killed on the going-away code",
        );
        // A peer that never pinged (an older build) is left alone,
        // however long it stays silent: the sweep judges only peers
        // that proved they heartbeat.
        const quiet = await authenticate(url);
        await delay(600);
        assert.equal(
          quiet.client.ws.readyState,
          WebSocket.OPEN,
          "a peer that never pinged must not be killed by the sweep",
        );
        quiet.client.send({
          t: "req",
          id: 1,
          channel: "test:echo",
          input: "still served",
        });
        const res = await quiet.client.nextFrame();
        assert.equal(res.result, "still served");
        quiet.client.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "liveness: the client transport heartbeats, declares a silent host dead within its timeout, and a probe reaches the verdict in its own shorter window",
    async () => {
      // A raw host that welcomes and then answers nothing: pings arrive,
      // pongs never leave. The real binding always answers, so the
      // dead-host path needs a host of its own.
      const silent = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const pingsSeen = [];
      silent.on("connection", (socket) => {
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString("utf8"));
          if (frame.t === "hello") {
            socket.send(
              encodeFrame({ t: "welcome", deviceId: "mute", appVersion: "1" }),
            );
          }
          if (frame.t === "ping") pingsSeen.push(Date.now());
        });
      });
      await new Promise((resolve) => silent.on("listening", resolve));
      const silentUrl = `ws://127.0.0.1:${silent.address().port}`;
      try {
        let closedWith = "unset";
        const startedAt = Date.now();
        const connection = await connectDevice({
          url: silentUrl,
          token: TOKEN,
          appVersion: "1",
          localDeviceId: "client",
          onClose: (code) => {
            closedWith = code;
          },
          heartbeat: { intervalMs: 40, timeoutMs: 150 },
        });
        await waitFor(
          () => closedWith !== "unset",
          "the heartbeat death",
          2_000,
        );
        assert.equal(
          closedWith,
          null,
          "a heartbeat death must report through onClose with a null code",
        );
        const elapsed = Date.now() - startedAt;
        assert.ok(
          elapsed >= 150 && elapsed < 1_000,
          `the death must land after the timeout and well before a socket-level verdict (took ${elapsed}ms)`,
        );
        assert.ok(pingsSeen.length >= 1, "the client must have pinged");
        await assert.rejects(
          () => connection.transport.invoke("test:echo", 1),
          /disconnected/,
          "the dead connection must reject invokes",
        );

        // The probe: a fresh connection whose heartbeat cadence is far
        // away, probed at once, reaches the verdict inside the probe
        // window instead.
        let probedClose = "unset";
        const probed = await connectDevice({
          url: silentUrl,
          token: TOKEN,
          appVersion: "1",
          localDeviceId: "client",
          onClose: (code) => {
            probedClose = code;
          },
          heartbeat: {
            intervalMs: 10_000,
            timeoutMs: 20_000,
            probeTimeoutMs: 100,
          },
        });
        const probedAt = Date.now();
        probed.probe();
        await waitFor(
          () => probedClose !== "unset",
          "the probe verdict",
          2_000,
        );
        const probeElapsed = Date.now() - probedAt;
        assert.ok(
          probeElapsed >= 100 && probeElapsed < 1_000,
          `the probe verdict must land in its own window (took ${probeElapsed}ms)`,
        );
      } finally {
        await new Promise((resolve) => {
          for (const socket of silent.clients) socket.terminate();
          silent.close(() => resolve());
        });
      }

      // Against the REAL binding the same cadence stays connected: pongs
      // keep answering, so a live host is never misjudged.
      const { binding, url } = await startBinding();
      try {
        let liveClose = "unset";
        const live = await connectDevice({
          url,
          token: TOKEN,
          appVersion: "1",
          localDeviceId: "client",
          onClose: (code) => {
            liveClose = code;
          },
          heartbeat: { intervalMs: 20, timeoutMs: 60 },
        });
        await delay(300);
        assert.equal(
          liveClose,
          "unset",
          "a host that answers pings must never be declared dead",
        );
        assert.equal(await live.transport.invoke("test:echo", "ok"), "ok");
        live.close();
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "registrar: onMutationResolved fires after a mutating invoke resolves, never for reads or failures",
    async () => {
      // The remote-viewer externalChange ping (main/ipc/register.ts)
      // hangs off this registrar hook, so pin its semantics at the seam
      // with an in-memory transport: the LAN wire refuses mutating
      // invokes outright, and the Electron+hub composite that
      // actually emits the ping imports electron, out of reach here.
      const handlers = new Map();
      const server = {
        handle: (channel, fn) => handlers.set(channel, fn),
        broadcastAll: () => {},
      };
      const pingContract = defineContract("host", {
        mutate: invoke("pingtest:mutate", z.void(), z.void(), {
          remote: true,
          mutating: true,
        }),
        read: invoke("pingtest:read", z.void(), z.void(), {
          remote: true,
          mutating: false,
        }),
        failMutate: invoke("pingtest:failMutate", z.void(), z.void(), {
          remote: true,
          mutating: true,
        }),
        // A command whose effects are invisible to remote viewers, the
        // forward-verb shape: still grant-gated, never pinged.
        shuttle: invoke("pingtest:shuttle", z.void(), z.void(), {
          remote: true,
          mutating: true,
          movesHostState: false,
        }),
      });
      let resolved = 0;
      let resolvedCtx = null;
      registerContract(
        pingContract,
        {
          mutate: async () => {},
          read: async () => {},
          failMutate: async () => {
            throw new Error("boom");
          },
          shuttle: async () => {},
        },
        server,
        {
          validateOutputs: true,
          onMutationResolved: (ctx) => {
            resolved += 1;
            resolvedCtx = ctx;
          },
        },
      );
      const ctx = { callerDeviceId: "peer-1" };
      await handlers.get("pingtest:read")(ctx, undefined);
      assert.equal(resolved, 0, "a read must not trip the mutation hook");
      await handlers.get("pingtest:mutate")(ctx, undefined);
      assert.equal(resolved, 1, "a resolved mutation must trip the hook");
      // The Electron binding reads the caller off this to decide
      // whether a remote peer drove the mutation (and so whether its
      // own windows need the ping too), so the hook must see the
      // calling peer's context, not a copy.
      assert.equal(
        resolvedCtx,
        ctx,
        "the hook must receive the calling peer's context",
      );
      await assert.rejects(() =>
        handlers.get("pingtest:failMutate")(ctx, undefined),
      );
      assert.equal(resolved, 1, "a failed mutation must not trip the hook");
      await handlers.get("pingtest:shuttle")(ctx, undefined);
      assert.equal(
        resolved,
        1,
        "a movesHostState:false mutation must not trip the hook",
      );
    },
  );

  await check(
    "contract invariant: every host-scoped invoke is explicitly tagged remote true or false",
    async () => {
      // Derive the host modules from the authoritative registry rather
      // than a hand-maintained list, so a newly added host contract module
      // is covered here automatically. A module that forgot to tag a call
      // remote can no longer skip this check by never appearing in a list.
      const hostModules = allContractModules.filter((m) => m.scope === "host");
      // The known host-module count at authoring time. The derived set must
      // cover every host module: an empty or shrunken set means the
      // registry import or the scope filter drifted and the invariant
      // quietly stopped running over some modules.
      const KNOWN_HOST_MODULE_COUNT = 16;
      assert.ok(
        hostModules.length >= KNOWN_HOST_MODULE_COUNT,
        `host-module coverage shrank: derived ${hostModules.length} host modules, expected at least ${KNOWN_HOST_MODULE_COUNT}`,
      );
      for (const module of hostModules) {
        // The channel namespace stands in for the module name in messages.
        const firstChannel = Object.values(module.calls)[0]?.channel ?? "?";
        const name = firstChannel.split(":")[0];
        for (const [key, def] of Object.entries(module.calls)) {
          if (def.kind !== "invoke") continue;
          assert.equal(
            typeof def.remote,
            "boolean",
            `${name}.${key} (${def.channel}) is not explicitly tagged remote`,
          );
          // Every remote:true invoke also classifies itself as a command
          // or a read, so a new remote call cannot silently join the wire
          // without declaring whether the hub grant model must gate it.
          // remote:false invokes never reach the grant check, so theirs
          // may stay undefined.
          if (def.remote === true) {
            assert.equal(
              typeof def.mutating,
              "boolean",
              `${name}.${key} (${def.channel}) is remote but not explicitly tagged mutating`,
            );
          }
          // movesHostState opts a mutating def out of the remote-viewer
          // cache ping. On a non-mutating def it is meaningless, so its
          // presence there is a tagging mistake.
          if (def.movesHostState !== undefined) {
            assert.equal(
              def.mutating,
              true,
              `${name}.${key} (${def.channel}) tags movesHostState without mutating:true`,
            );
          }
        }
      }
      // Spot-check the load-bearing decisions so a silent flip is caught.
      assert.equal(runtimeContract.calls.nuke.remote, false);
      assert.equal(runtimeContract.calls.moveRoot.remote, false);
      assert.equal(runtimeContract.calls.info.remote, false);
      assert.equal(launchersContract.calls.launch.remote, false);
      assert.equal(cliContract.calls.install.remote, false);
      assert.equal(globalConfigContract.calls.write.remote, false);
      assert.equal(globalConfigContract.calls.readLocal.remote, false);
      assert.equal(globalConfigContract.calls.read.remote, true);
      assert.equal(worktreesContract.calls.create.remote, true);
      // Spot-check the mutating classification so a read cannot silently
      // become a command (served ungated to every peer) or a command a
      // read (served ungated too).
      assert.equal(worktreesContract.calls.create.mutating, true);
      assert.equal(worktreesContract.calls.list.mutating, false);
      assert.equal(worktreesContract.calls.push.mutating, true);
      assert.equal(scriptsContract.calls.run.mutating, true);
      assert.equal(gitContract.calls.refreshProject.mutating, true);
      assert.equal(globalConfigContract.calls.read.mutating, false);
      // The step-6 flips (v2 slice B). Every fs call is remote AND
      // mutating: they read, but they disclose arbitrary absolute
      // paths, so they ride the command grant rather than the ungated
      // read set.
      for (const key of ["listDirectory", "scanForGitRepos", "isGitRepo"]) {
        assert.equal(fsContract.calls[key].remote, true, `fs.${key} remote`);
        assert.equal(
          fsContract.calls[key].mutating,
          true,
          `fs.${key} must require the command grant`,
        );
      }
      // The projects and packageScripts preference/registry writes are
      // commands on the remote surface now.
      for (const key of [
        "add",
        "remove",
        "reorder",
        "setSort",
        "setSidebarView",
        "toggleCollapsed",
      ]) {
        assert.equal(
          projectsContract.calls[key].remote,
          true,
          `projects.${key} remote`,
        );
        assert.equal(
          projectsContract.calls[key].mutating,
          true,
          `projects.${key} mutating`,
        );
      }
      assert.equal(packageScriptsContract.calls.setSort.remote, true);
      assert.equal(packageScriptsContract.calls.setSort.mutating, true);
      // The step-7 sync transfer surface (v2 slice B, refTips added by
      // slice C): every call is a command, so the whole bundle-transfer
      // path rides the per-peer grant and the read-only LAN wire
      // refuses it outright.
      for (const key of [
        "refTips",
        "captureDirty",
        "bundleStart",
        "bundleChunk",
        "bundleAbort",
      ]) {
        assert.equal(
          syncContract.calls[key].remote,
          true,
          `sync.${key} remote`,
        );
        assert.equal(
          syncContract.calls[key].mutating,
          true,
          `sync.${key} must require the command grant`,
        );
      }
      // The transfer verbs opt out of the viewer cache ping: serving a
      // transfer moves no state a remote viewer caches, and without the
      // opt-out every chunk resolution of a multi-minute pull would
      // re-invalidate every viewing peer's cached forest. captureDirty
      // stays opted in -- it writes a capture ref, real host state.
      for (const key of [
        "refTips",
        "bundleStart",
        "bundleChunk",
        "bundleAbort",
      ]) {
        assert.equal(
          syncContract.calls[key].movesHostState,
          false,
          `sync.${key} must opt out of the viewer cache ping`,
        );
      }
      assert.notEqual(
        syncContract.calls.captureDirty.movesHostState,
        false,
        "sync.captureDirty writes a ref and must keep the viewer cache ping",
      );
      // The byte-stream opens (step 8, reworked onto channels): both
      // are grant-gated commands, but neither moves state a remote
      // viewer caches, so both opt out of the mutation cache ping. The
      // bytes themselves ride binary channel frames, never invokes.
      for (const [name, call] of [
        ["forward.open", forwardContract.calls.open],
        ["mirror.openStream", mirrorContract.calls.openStream],
      ]) {
        assert.equal(call.remote, true, `${name} remote`);
        assert.equal(
          call.mutating,
          true,
          `${name} must require the command grant`,
        );
        assert.equal(
          call.movesHostState,
          false,
          `${name} must opt out of the viewer cache ping`,
        );
      }
      // The pull orchestrator is LOCAL-only: a
      // device's own renderer drives it, and it must never be servable
      // to a peer -- a remote:false host invoke is simply not
      // registered on either remote wire.
      assert.equal(syncContract.calls.pullWorktree.remote, false);
      assert.equal(syncContract.calls.pullWorktree.mutating, true);
      // The source teardown after a pull is the same
      // local-only shape: its remote half is the peer's ordinary
      // worktrees:delete.
      assert.equal(syncContract.calls.teardownSource.remote, false);
      assert.equal(syncContract.calls.teardownSource.mutating, true);
      // The pull's progress frames go back to the invoking renderer
      // only: an untagged broadcast never reaches a remote wire.
      assert.notEqual(syncContract.calls.pullProgress.remote, true);
      // The preflight read is remote and explicitly a read, so every
      // wire serves it ungated.
      assert.equal(remoteAccessContract.calls.commandAccess.remote, true);
      assert.equal(remoteAccessContract.calls.commandAccess.mutating, false);
      // The remote device-settings write: a command, and its STRICT
      // patch schema must reject the keys that could hand a peer the
      // hosting token or the outbound device list. The rejection is
      // structural (unknown key -> parse error), not a strip.
      const writeDeviceSettings =
        globalConfigContract.calls.writeDeviceSettings;
      assert.equal(writeDeviceSettings.remote, true);
      assert.equal(writeDeviceSettings.mutating, true);
      assert.equal(
        writeDeviceSettings.input.safeParse({
          patch: { socketHost: { enabled: true, lan: true, token: "x" } },
        }).success,
        false,
        "writeDeviceSettings accepted a socketHost key",
      );
      assert.equal(
        writeDeviceSettings.input.safeParse({
          patch: {
            remoteDevices: [{ url: "ws://evil", token: "t" }],
          },
        }).success,
        false,
        // Legacy key of the removed LAN feature. As an unknown key the
        // strict patch schema must keep rejecting it.
        "writeDeviceSettings accepted a remoteDevices key",
      );
      assert.equal(
        writeDeviceSettings.input.safeParse({ patch: {} }).success,
        true,
        "an empty patch must parse",
      );
      assert.equal(
        writeDeviceSettings.input.safeParse({
          patch: { githubCli: false, portPool: true },
        }).success,
        true,
        "a managed-keys patch must parse",
      );
    },
  );

  await check(
    "golden read surface: the ungated read channels match read-surface.golden.json",
    async () => {
      // The spot-checks above prove chosen tags, but nothing proved the
      // WHOLE read/mutate axis: a single mutating:true flipped to false
      // would serve that channel ungated to any account peer with the
      // battery still green. Pinning the full ungated surface in a
      // committed golden file turns any such flip into a reviewed diff.
      const goldenPath = join(
        dirname(fileURLToPath(import.meta.url)),
        "read-surface.golden.json",
      );
      const derived = allContractModules
        .filter((module) => module.scope === "host")
        .flatMap((module) => Object.values(module.calls))
        .filter(
          (def) =>
            def.kind === "invoke" &&
            def.remote === true &&
            def.mutating === false,
        )
        .map((def) => def.channel)
        .toSorted();
      if (process.argv.includes("--update")) {
        writeFileSync(goldenPath, `${JSON.stringify(derived, null, 2)}\n`);
        console.log(
          `      wrote ${derived.length} channels to read-surface.golden.json`,
        );
        return;
      }
      const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
      const goldenSet = new Set(golden);
      const derivedSet = new Set(derived);
      const opened = derived.filter((channel) => !goldenSet.has(channel));
      const closed = golden.filter((channel) => !derivedSet.has(channel));
      if (opened.length > 0 || closed.length > 0) {
        assert.fail(
          [
            "the ungated read surface drifted from scripts/read-surface.golden.json",
            ...opened.map((channel) => `  now servable ungated: ${channel}`),
            ...closed.map((channel) => `  no longer servable:   ${channel}`),
            "if the change is deliberate, regenerate with: pnpm socket:check --update",
          ].join("\n"),
        );
      }
    },
  );

  done();
}

main().catch(fail);
