// Durable proof for the direct listener (host/socket/server.ts).
// Starts a real listener on an ephemeral loopback port (the shared
// fixture in test/lib/directBoot.mjs) and drives real ws clients
// against it through the ticket-proof handshake, asserting the
// dispatch, broadcast and framing paths PLUS the hardening:
// terminate-on-bad-proof (a hello with no proof, the retired
// token-only shape, included), post-timeout hello rejection,
// oversized-frame rejection, the Origin gate (origin-less, loopback
// and the configured web origin pass, the renderer scheme and a
// foreign web origin are refused), the no-handler answer a non-remote
// channel gets, the per-socket in-flight cap, the stopped-listener
// generation guard, liveness on both ends, deflated frames, and the
// contract invariant that every host invoke is explicitly tagged
// remote true or false.
//
// The command gate: the listener serves a channel registered
// gated:false to every authed peer, and anything else (a mutating
// or untagged channel) only while the host accepts commands, refusing
// it with the shared command-refused code BEFORE its handler runs. The
// client transport maps that code to the typed CommandRefusedError.
// The grant flipping live on one session, the ticket rules and the
// brokering are direct-plane.mjs's.
//
// The golden read surface: every channel servable ungated (remote:true,
// gated:false) is pinned in read-surface.golden.json, so flipping a
// mutating tag shows up as a reviewed diff instead of silently opening
// or closing the ungated wire. Regenerate deliberately with
// `pnpm test socket-host --update`.
//
// Runs under test/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. Run: pnpm test socket-host.
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { DEFLATED_FRAME_KIND } from "@shared/ipc/socket/deflatedFrame";
import { handshakeProof, newHandshakeNonce } from "@shared/ipc/socket/proof";
import { openDevice } from "@shared/ipc/socket/wsClientTransport";
import { rendererSchemeOrigin } from "@shared/packaging/rendererScheme.mts";
import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { registerContract } from "@shared/ipc/registerContract";
import { accountContract } from "@shared/ipc/modules/account";
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
import { startDirectListener } from "./lib/directBoot.mjs";

const WS_CLOSE_TOO_BIG = 1009;
// The dialing peer every ticket below is minted for.
const CLIENT = "client";
// A ticket the listener never minted: its proof answers nothing.
const UNMINTED = "smpt_never_minted";
// What the local cloudflared connector adds to a tunnel-borne
// connection, which the listener reads as the "tunnel" candidate kind.
const TUNNEL_HEADERS = { "cf-connecting-ip": "203.0.113.7" };

// Shared handler state referenced by registerTestHandlers. Reset by the
// tests that use it.
let hangResolvers = [];
let countExecutions = 0;
let mutateExecutions = 0;
let untaggedExecutions = 0;

function registerTestHandlers(binding) {
  // The generic-path handlers are EXPLICIT reads (gated:false): the
  // command gate is fail-closed and serves only channels proven
  // read-only while commands are off (the fixture's default), so
  // tagging them keeps the dispatch/framing/broadcast tests serving.
  binding.handle("test:echo", async (_ctx, raw) => raw, { gated: false });
  binding.handle(
    "test:hang",
    () => new Promise((resolve) => hangResolvers.push(resolve)),
    { gated: false },
  );
  binding.handle(
    "test:count",
    async () => {
      countExecutions += 1;
    },
    { gated: false },
  );
  // A read-classified handler that throws, so the typed-error test can
  // prove a REAL failure stays a plain Error rather than the refusal
  // type.
  binding.handle(
    "test:fail",
    async () => {
      throw new Error("boom");
    },
    { gated: false },
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
    { gated: true },
  );
  binding.handle("test:untagged", async () => {
    untaggedExecutions += 1;
    return "ran";
  });
}

// The shared listener fixture with this check's test handlers, a short
// hello timeout, and a mint for the one peer every dial here claims to
// be. `kind` is the candidate kind the connection will arrive as:
// "tunnel" for one carrying TUNNEL_HEADERS, "lan" otherwise.
async function startListener(track, start = {}) {
  const listener = await startDirectListener(track, {
    deviceId: "host-device",
    registerHandlers: registerTestHandlers,
    start: { helloTimeoutMs: 300, ...start },
  });
  return {
    ...listener,
    url: `ws://127.0.0.1:${listener.port}`,
    mint: (kind = "lan") => listener.tickets.mint(CLIENT, [kind])[0],
  };
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

// The client half of the handshake on a raw socket: read the host's
// challenge, then hello with a proof of `ticket` over both nonces.
// Resolves with what the host's welcome proof must be. `extra` rides
// the hello (a deflate ask).
async function sendProvenHello(client, ticket, extra = {}) {
  const challenge = await client.nextFrame();
  assert.equal(challenge.t, "challenge", "the host must open with a nonce");
  const nonce = newHandshakeNonce();
  client.send({
    t: "hello",
    deviceId: CLIENT,
    appVersion: "1",
    nonce,
    proof: await handshakeProof(ticket, "client", challenge.nonce, nonce),
    ...extra,
  });
  return handshakeProof(ticket, "host", challenge.nonce, nonce);
}

async function authenticate(listener, { headers, kind, extra } = {}) {
  const client = connect(listener.url, headers);
  await client.opened;
  const hostProof = await sendProvenHello(
    client,
    listener.mint(kind ?? (headers === undefined ? "lan" : "tunnel")),
    extra,
  );
  const welcome = await client.nextFrame();
  assert.equal(
    welcome.t,
    "welcome",
    "expected a welcome frame after a proven hello",
  );
  return { client, welcome, hostProof };
}

// The real client transport against a URL, holding `ticket`.
function dial(url, ticket, overrides = {}) {
  return openDevice({
    url,
    ticket,
    appVersion: "1",
    localDeviceId: CLIENT,
    onClose: () => {},
    ...overrides,
  }).authenticate();
}

// A stand-in host, to put exact bytes on the wire: runs the proof
// handshake for FAKE_TICKET, then hands the socket to the check.
// `onFrame` sees every client frame after the welcome.
const FAKE_TICKET = "smpt_fake_host_ticket";
async function fakeHost(track, { afterWelcome, onFrame } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  track(
    () =>
      new Promise((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  );
  wss.on("connection", (ws) => {
    const hostNonce = newHandshakeNonce();
    ws.send(encodeFrame({ t: "challenge", nonce: hostNonce }));
    let welcomed = false;
    ws.on("message", async (data) => {
      const frame = JSON.parse(data.toString("utf8"));
      if (welcomed) {
        onFrame?.(ws, frame);
        return;
      }
      welcomed = true;
      const proof = await handshakeProof(
        FAKE_TICKET,
        "host",
        hostNonce,
        frame.nonce,
      );
      ws.send(
        encodeFrame({
          t: "welcome",
          deviceId: "fake-host",
          appVersion: "1",
          proof,
        }),
      );
      afterWelcome?.(ws);
    });
  });
  return `ws://127.0.0.1:${wss.address().port}`;
}
const deflatedFrame = (frame) =>
  Buffer.concat([
    Buffer.from([DEFLATED_FRAME_KIND]),
    deflateRawSync(Buffer.from(encodeFrame(frame))),
  ]);

// The raw messages a socket receives, binary or text, in order.
function rawMessages(ws) {
  const seen = [];
  ws.on("message", (data, isBinary) => seen.push({ data, isBinary }));
  return seen;
}

const { check, done, fail } = makeProof("socket-host proof");

async function main() {
  console.log("socket-host security proof\n");

  await check(
    "auth handshake: a proven ticket gets a welcome carrying host identity and the host's half of the proof",
    async (track) => {
      const listener = await startListener(track);
      const { client, welcome, hostProof } = await authenticate(listener);
      assert.equal(welcome.deviceId, "host-device");
      assert.equal(welcome.appVersion, "2.0.0");
      assert.equal(welcome.proof, hostProof);
      client.close();
    },
  );

  await check(
    "dispatch: a req gets a matching res echoing the handler result",
    async (track) => {
      const { client } = await authenticate(await startListener(track));
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
    },
  );

  await check(
    "framing: a void input round-trips as an absent field",
    async (track) => {
      const { client } = await authenticate(await startListener(track));
      client.send({ t: "req", id: 1, channel: "test:echo" });
      const res = await client.nextFrame();
      assert.equal(res.ok, true);
      assert.equal(res.result, undefined);
      assert.equal("result" in res, false);
      client.close();
    },
  );

  await check(
    "broadcast: broadcastAll pushes a frame to an authed socket",
    async (track) => {
      const listener = await startListener(track);
      const { client } = await authenticate(listener);
      listener.binding.broadcastAll("test:ping", { n: 5 });
      const push = await client.nextFrame();
      assert.equal(push.t, "push");
      assert.equal(push.channel, "test:ping");
      assert.deepEqual(push.payload, { n: 5 });
      client.close();
    },
  );

  await check(
    "terminate on bad proof: a proof of no pending ticket, and a hello with no proof at all, close CLOSE_AUTH_FAILED with nothing answered",
    async (track) => {
      const listener = await startListener(track);
      const hellos = [
        (client) => sendProvenHello(client, UNMINTED),
        // The retired token-only hello: a credential in the clear
        // proves nothing here.
        async (client) => {
          assert.equal((await client.nextFrame()).t, "challenge");
          client.send({
            t: "hello",
            token: listener.mint(),
            deviceId: CLIENT,
            appVersion: "1",
          });
        },
      ];
      for (const hello of hellos) {
        const client = connect(listener.url);
        // oxlint-disable-next-line no-await-in-loop -- one socket at a time
        await client.opened;
        // oxlint-disable-next-line no-await-in-loop -- one socket at a time
        await hello(client);
        // Nothing is pipelined behind the hello: the proof check is
        // async, and a req landing before the verdict is itself a
        // malformed hello, a different refusal.
        // oxlint-disable-next-line no-await-in-loop -- one socket at a time
        const close = await client.waitClose();
        assert.equal(close.code, CLOSE_AUTH_FAILED, close.reason);
        assert.equal(client.pending(), 0, "the rejected hello was answered");
      }
    },
  );

  await check(
    "post-timeout hello: a hello after the hello timeout cannot authenticate",
    async (track) => {
      const listener = await startListener(track, { helloTimeoutMs: 100 });
      const client = connect(listener.url);
      await client.opened;
      const challenge = await client.nextFrame();
      await delay(250);
      // The timeout already fired. A late (correctly proven) hello must
      // not auth.
      const nonce = newHandshakeNonce();
      client.send({
        t: "hello",
        deviceId: CLIENT,
        appVersion: "1",
        nonce,
        proof: await handshakeProof(
          listener.mint(),
          "client",
          challenge.nonce,
          nonce,
        ),
      });
      const close = await client.waitClose();
      assert.equal(close.code, CLOSE_HELLO_FAILED);
      assert.equal(
        client.pending(),
        0,
        "a welcome was sent after the hello timeout",
      );
    },
  );

  await check(
    "non-remote channel: a host channel the listener never registered gets a no-handler res",
    async (track) => {
      const { client } = await authenticate(await startListener(track));
      // runtime:nuke is a real host channel tagged remote:false, so it
      // is never registered on this binding and can never execute.
      client.send({ t: "req", id: 3, channel: "runtime:nuke", input: {} });
      const res = await client.nextFrame();
      assert.equal(res.ok, false);
      assert.match(res.message, /No handler registered/);
      client.close();
    },
  );

  await check(
    "oversized frame: an inbound frame over the 1 MiB cap closes the socket",
    async (track) => {
      const { client } = await authenticate(await startListener(track));
      const huge = "x".repeat((1 << 20) + 1024);
      client.send({ t: "req", id: 9, channel: "test:echo", input: huge });
      const close = await client.waitClose();
      assert.equal(close.code, WS_CLOSE_TOO_BIG);
    },
  );

  await check(
    "Origin gate: origin-less, loopback and the configured web origin complete the handshake, while the renderer scheme and a foreign origin are refused",
    async (track) => {
      // Browser-global WebSocket clients (the web client's direct dials)
      // ALWAYS send an Origin: the deployed web client's own, admitted
      // only when this device names it, or a loopback http origin from
      // a locally served one. The desktop's dialer sends none.
      const WEB_ORIGIN = "https://web.example.test";
      const listener = await startListener(track, {
        allowedOrigin: WEB_ORIGIN,
      });
      for (const origin of [
        undefined,
        "http://localhost:5190",
        "http://127.0.0.1:5190",
        WEB_ORIGIN,
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one shared listener, sequential hellos
        const { client } = await authenticate(listener, {
          headers: origin === undefined ? undefined : { origin },
          kind: "lan",
        });
        client.close();
      }
      // Nothing in the app dials from a renderer page, so its scheme
      // has no business here.
      for (const origin of [
        "https://evil.example",
        rendererSchemeOrigin("prod"),
        rendererSchemeOrigin("dev"),
      ]) {
        const client = connect(listener.url, { origin });
        // oxlint-disable-next-line no-await-in-loop -- sequential refusals
        await assert.rejects(client.opened, `origin ${origin} was admitted`);
      }
      // The web origin is admitted only where it is configured.
      const unconfigured = await startListener(track);
      const client = connect(unconfigured.url, { origin: WEB_ORIGIN });
      await assert.rejects(client.opened);
    },
  );

  await check(
    "in-flight cap: one request past the shared per-peer cap is refused rather than dispatched",
    async (track) => {
      hangResolvers = [];
      const { client } = await authenticate(await startListener(track));
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
    },
  );

  await check(
    "generation guard: no handler executes under a stopped listener",
    async (track) => {
      countExecutions = 0;
      const listener = await startListener(track, { helloTimeoutMs: 2000 });
      const { client } = await authenticate(listener);
      // stopNow drops the listener synchronously, so requests arriving
      // during the terminate grace window fail the generation guard.
      const stopping = listener.binding.stop();
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
    "command gate: with commands off a mutating and an untagged channel are refused with the typed code and their handlers never run, a read-only channel is still served, and with commands on both run",
    async (track) => {
      mutateExecutions = 0;
      untaggedExecutions = 0;
      const listener = await startListener(track);
      const { client } = await authenticate(listener);
      // (a) gated:true is refused with the machine-readable code
      // and the handler body never runs.
      client.send({ t: "req", id: 1, channel: "test:mutate" });
      const mutateRes = await client.nextFrame();
      assert.equal(mutateRes.ok, false);
      assert.equal(mutateRes.code, COMMAND_REFUSED_CODE);
      assert.match(mutateRes.message, /not permitted to run commands/);
      assert.equal(mutateExecutions, 0, "a mutating handler ran ungranted");
      // (b) an UNTAGGED channel is refused too: only channels proven
      // read-only are served ungated, so unclassified defaults closed.
      client.send({ t: "req", id: 2, channel: "test:untagged" });
      const untaggedRes = await client.nextFrame();
      assert.equal(untaggedRes.ok, false);
      assert.equal(untaggedRes.code, COMMAND_REFUSED_CODE);
      assert.equal(untaggedExecutions, 0, "an untagged handler ran ungranted");
      // (c) an explicit read on the same socket is served as before.
      client.send({ t: "req", id: 3, channel: "test:echo", input: "read" });
      const echoRes = await client.nextFrame();
      assert.equal(echoRes.ok, true);
      assert.equal(echoRes.result, "read");
      // (d) the switch on, read live: both run on the same socket. The
      // flip itself reaches the peer first, as the push that carries
      // the switch (what its bridge records for its UI and CLI).
      listener.setAccepts(true);
      assert.deepEqual(await client.nextFrame(), {
        t: "push",
        channel: "account:commandAccessChanged",
        payload: true,
      });
      client.send({ t: "req", id: 4, channel: "test:mutate" });
      assert.equal((await client.nextFrame()).result, "mutated");
      client.send({ t: "req", id: 5, channel: "test:untagged" });
      assert.equal((await client.nextFrame()).result, "ran");
      client.close();
    },
  );

  await check(
    "typed refusal client-side: the client transport maps the code to CommandRefusedError while a real handler failure stays a plain Error",
    async (track) => {
      const listener = await startListener(track);
      const connection = await dial(listener.url, listener.mint());
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
    },
  );

  await check(
    "liveness: the host answers pings and kills a heartbeating peer that falls silent, but never judges a peer that never pinged",
    async (track) => {
      const listener = await startListener(track, { livenessTimeoutMs: 200 });
      // A peer that pings once proves it heartbeats: it gets a pong,
      // and going silent past the timeout then ends its socket.
      const { client } = await authenticate(listener);
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
      const quiet = await authenticate(listener);
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
    },
  );

  await check(
    "liveness: the client transport heartbeats, declares a silent host dead within its timeout, and a probe reaches the verdict in its own shorter window",
    async (track) => {
      // A host that welcomes and then answers nothing: pings arrive,
      // pongs never leave. The real binding always answers, so the
      // dead-host path needs a host of its own.
      const pingsSeen = [];
      const silentUrl = await fakeHost(track, {
        onFrame: (_ws, frame) => {
          if (frame.t === "ping") pingsSeen.push(Date.now());
        },
      });
      let closedWith = "unset";
      const startedAt = Date.now();
      const connection = await dial(silentUrl, FAKE_TICKET, {
        onClose: (code) => {
          closedWith = code;
        },
        heartbeat: { intervalMs: 40, timeoutMs: 150 },
      });
      await waitFor(() => closedWith !== "unset", "the heartbeat death", 2_000);
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
      const probed = await dial(silentUrl, FAKE_TICKET, {
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
      await waitFor(() => probedClose !== "unset", "the probe verdict", 2_000);
      const probeElapsed = Date.now() - probedAt;
      assert.ok(
        probeElapsed >= 100 && probeElapsed < 1_000,
        `the probe verdict must land in its own window (took ${probeElapsed}ms)`,
      );

      // Against the REAL binding the same cadence stays connected: pongs
      // keep answering, so a live host is never misjudged.
      const listener = await startListener(track);
      let liveClose = "unset";
      const live = await dial(listener.url, listener.mint(), {
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
    },
  );

  await check(
    "registrar: onMutationResolved fires after a mutating invoke resolves, never for reads or failures",
    async () => {
      // The remote-viewer externalChange ping (main/ipc/register.ts)
      // hangs off this registrar hook, so pin its semantics at the seam
      // with an in-memory transport: the Electron+direct composite that
      // actually emits the ping imports electron, out of reach here.
      const handlers = new Map();
      const server = {
        handle: (channel, fn) => handlers.set(channel, fn),
        broadcastAll: () => {},
      };
      const pingContract = defineContract("host", {
        mutate: invoke("pingtest:mutate", z.void(), z.void(), {
          remote: true,
          gated: true,
        }),
        read: invoke("pingtest:read", z.void(), z.void(), {
          remote: true,
          gated: false,
        }),
        failMutate: invoke("pingtest:failMutate", z.void(), z.void(), {
          remote: true,
          gated: true,
        }),
        // A command whose effects are invisible to remote viewers, the
        // forward-verb shape: still grant-gated, never pinged.
        shuttle: invoke("pingtest:shuttle", z.void(), z.void(), {
          remote: true,
          gated: true,
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
          // without declaring whether the command-access gate covers it.
          // remote:false invokes never reach the gate, so theirs
          // may stay undefined.
          if (def.remote === true) {
            assert.equal(
              typeof def.gated,
              "boolean",
              `${name}.${key} (${def.channel}) is remote but not explicitly tagged mutating`,
            );
          }
          // movesHostState opts a mutating def out of the remote-viewer
          // cache ping. On a non-mutating def it is meaningless, so its
          // presence there is a tagging mistake.
          if (def.movesHostState !== undefined) {
            assert.equal(
              def.gated,
              true,
              `${name}.${key} (${def.channel}) tags movesHostState without gated:true`,
            );
          }
        }
      }
      // Spot-check the load-bearing decisions so a silent flip is caught.
      assert.equal(runtimeContract.calls.nuke.remote, false);
      // A peer may relocate the data folder, but only as a command.
      assert.equal(runtimeContract.calls.moveDataDir.remote, true);
      assert.equal(runtimeContract.calls.moveDataDir.gated, true);
      // info is the one runtime call a peer may make: the project pages
      // under a device twin spell worktree paths off its data dir. It
      // rides the command grant like the fs reads, since it names the
      // host's paths.
      assert.equal(runtimeContract.calls.info.remote, true);
      assert.equal(runtimeContract.calls.info.gated, true);
      assert.equal(runtimeContract.calls.info.movesHostState, false);
      assert.equal(launchersContract.calls.launch.remote, false);
      // The cli module rides the wire wholly behind the grant: even
      // its status reads name host paths, so none of it is ungated.
      for (const def of Object.values(cliContract.calls)) {
        assert.equal(def.remote, true);
        assert.equal(def.gated, true);
      }
      assert.equal(globalConfigContract.calls.read.remote, true);
      assert.equal(worktreesContract.calls.create.remote, true);
      // Spot-check the mutating classification so a read cannot silently
      // become a command (served ungated to every peer) or a command a
      // read (served ungated too).
      assert.equal(worktreesContract.calls.create.gated, true);
      assert.equal(worktreesContract.calls.list.gated, false);
      assert.equal(worktreesContract.calls.push.gated, true);
      assert.equal(scriptsContract.calls.run.gated, true);
      assert.equal(gitContract.calls.refreshProject.gated, true);
      // The sweep is the host's own scheduled pass. A peer's request
      // only decides when it runs, so it is read-class despite the git
      // and gh it spawns.
      assert.equal(gitContract.calls.sweep.gated, false);
      assert.equal(globalConfigContract.calls.read.gated, false);
      // The step-6 flips (v2 slice B). Every fs call is remote AND
      // gated: they read, but they disclose arbitrary absolute
      // paths, so they ride the command grant rather than the ungated
      // read set.
      for (const key of ["listDirectory", "scanForGitRepos", "isGitRepo"]) {
        assert.equal(fsContract.calls[key].remote, true, `fs.${key} remote`);
        assert.equal(
          fsContract.calls[key].gated,
          true,
          `fs.${key} must require the command grant`,
        );
      }
      // The projects registry writes and the packageScripts preference
      // write are commands on the remote surface now.
      for (const key of ["add", "remove", "reorder"]) {
        assert.equal(
          projectsContract.calls[key].remote,
          true,
          `projects.${key} remote`,
        );
        assert.equal(
          projectsContract.calls[key].gated,
          true,
          `projects.${key} mutating`,
        );
      }
      assert.equal(packageScriptsContract.calls.setSort.remote, true);
      assert.equal(packageScriptsContract.calls.setSort.gated, true);
      // The sync surface a peer drives: every call is a command, so the
      // whole transfer path rides the command grant. The source links
      // (openSource, receiveWorktree, receiveBundle) are the only way
      // commits cross, bytes on a channel the grant already gates.
      for (const key of [
        "ignoredPaths",
        "worktreeFolder",
        "hasCommits",
        "openSource",
        "receiveWorktree",
        "receiveBundle",
        "cancelMove",
      ]) {
        assert.equal(
          syncContract.calls[key].remote,
          true,
          `sync.${key} remote`,
        );
        assert.equal(
          syncContract.calls[key].gated,
          true,
          `sync.${key} must require the command grant`,
        );
      }
      // The reads, the link open and the cancel opt out of the viewer
      // cache ping: they move no state a remote viewer caches (a
      // capture taken over a link writes a ref the git watcher
      // announces, and a cancel's rollback resolves under the cancelled
      // call). The two receives land refs and a worktree, and keep it.
      for (const key of [
        "ignoredPaths",
        "worktreeFolder",
        "hasCommits",
        "openSource",
        "cancelMove",
      ]) {
        assert.equal(
          syncContract.calls[key].movesHostState,
          false,
          `sync.${key} must opt out of the viewer cache ping`,
        );
      }
      for (const key of ["receiveWorktree", "receiveBundle"]) {
        assert.notEqual(
          syncContract.calls[key].movesHostState,
          false,
          `sync.${key} lands refs and must keep the viewer cache ping`,
        );
      }
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
          call.gated,
          true,
          `${name} must require the command grant`,
        );
        assert.equal(
          call.movesHostState,
          false,
          `${name} must opt out of the viewer cache ping`,
        );
      }
      // The move orchestrators and the teardown are LOCAL-only: a
      // device's own renderer drives them, and they must never be
      // servable to a peer -- a remote:false host invoke is simply not
      // registered on the direct listener. What a peer drives is the
      // landing half above, which rides the command grant.
      for (const name of ["pullWorktree", "sendWorktree", "teardownSource"]) {
        assert.equal(syncContract.calls[name].remote, false);
        assert.equal(syncContract.calls[name].gated, true);
      }
      // The pull's progress frames go back to the invoking renderer
      // only: an untagged broadcast never reaches a remote wire.
      assert.notEqual(syncContract.calls.pullProgress.remote, true);
      // The command-access switch reaches peers as a push carrying it:
      // the one client-scoped broadcast tagged remote. The switch's
      // read and write stay client-scoped and untagged, so neither is
      // ever served to a peer.
      const { commandAccessChanged, acceptsCommands, setAcceptsCommands } =
        accountContract.calls;
      assert.equal(accountContract.scope, "client");
      assert.equal(commandAccessChanged.remote, true);
      assert.equal(commandAccessChanged.payload.safeParse(true).success, true);
      assert.notEqual(acceptsCommands.remote, true);
      assert.notEqual(setAcceptsCommands.remote, true);
      // The device-settings write, the only settings write: a command,
      // and its STRICT patch schema must reject every key the Settings
      // form does not manage, so a peer cannot stop this device serving
      // peers or point it at another connector binary. The rejection is
      // structural (unknown key -> parse error), not a strip.
      const writeDeviceSettings =
        globalConfigContract.calls.writeDeviceSettings;
      assert.equal(writeDeviceSettings.remote, true);
      assert.equal(writeDeviceSettings.gated, true);
      for (const patch of [
        { directConnections: false },
        { cloudflaredPath: "/tmp/not-cloudflared" },
      ]) {
        assert.equal(
          writeDeviceSettings.input.safeParse({ patch }).success,
          false,
          `writeDeviceSettings accepted ${JSON.stringify(patch)}`,
        );
      }
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
      // WHOLE read/mutate axis: a single gated:true flipped to false
      // would serve that channel ungated to any account peer with the
      // battery still green. Pinning the full ungated surface in a
      // committed golden file turns any such flip into a reviewed diff.
      const goldenPath = join(import.meta.dirname, "read-surface.golden.json");
      const derived = allContractModules
        .filter((module) => module.scope === "host")
        .flatMap((module) => Object.values(module.calls))
        .filter(
          (def) =>
            def.kind === "invoke" && def.remote === true && def.gated === false,
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
            "the ungated read surface drifted from test/read-surface.golden.json",
            ...opened.map((channel) => `  now servable ungated: ${channel}`),
            ...closed.map((channel) => `  no longer servable:   ${channel}`),
            "if the change is deliberate, regenerate with: pnpm test socket-host --update",
          ].join("\n"),
        );
      }
    },
  );

  // Deflated frames (shared/ipc/socket/deflatedFrame.ts). The host
  // deflates a large text frame only for a tunnel-borne connection
  // (loopback plus the connector's CF-Connecting-IP) whose hello asked.
  const bigValue = { patch: "a line of a diff that repeats\n".repeat(4_000) };

  await check(
    "deflate: a tunnel-borne client that asks gets a large res deflated, and reads it",
    async (track) => {
      const listener = await startListener(track);
      let socket;
      const connection = await dial(listener.url, listener.mint("tunnel"), {
        openSocket: (target) => {
          socket = new WebSocket(target, { headers: TUNNEL_HEADERS });
          return socket;
        },
      });
      const seen = rawMessages(socket);
      const result = await connection.transport.invoke("test:echo", bigValue);
      assert.deepEqual(result, bigValue, "the inflated result is intact");
      assert.equal(seen.length, 1);
      assert.equal(seen[0].isBinary, true, "the res crossed as a binary frame");
      assert.equal(seen[0].data[0], DEFLATED_FRAME_KIND);
      assert.ok(
        seen[0].data.length < JSON.stringify(bigValue).length / 10,
        "and as a fraction of its text",
      );
      // A small answer is not worth deflating and stays text.
      await connection.transport.invoke("test:echo", { hi: 1 });
      assert.equal(seen[1].isBinary, false);
      connection.close();
    },
  );

  await check(
    "deflate: frames behind a deflating one keep their order",
    async (track) => {
      const listener = await startListener(track);
      const connection = await dial(listener.url, listener.mint("tunnel"), {
        openSocket: (target) =>
          new WebSocket(target, { headers: TUNNEL_HEADERS }),
      });
      const order = [];
      connection.transport.subscribe("test:ping", (payload) =>
        order.push(payload.n),
      );
      // A big push (deflated, async on both ends) chased by small
      // ones (text, sync on both ends).
      listener.binding.broadcastAll("test:ping", { n: 1, pad: bigValue });
      listener.binding.broadcastAll("test:ping", { n: 2 });
      listener.binding.broadcastAll("test:ping", { n: 3, pad: bigValue });
      listener.binding.broadcastAll("test:ping", { n: 4 });
      await waitFor(() => order.length === 4, "four pushes");
      assert.deepEqual(order, [1, 2, 3, 4]);
      connection.close();
    },
  );

  await check(
    "deflate: a LAN-borne client, and one that never asked, get plain text",
    async (track) => {
      const listener = await startListener(track);
      // Asks (the client transport always does where it can inflate),
      // but arrives without the connector's header: a LAN peer.
      let lanSocket;
      const lan = await dial(listener.url, listener.mint("lan"), {
        openSocket: (target) => {
          lanSocket = new WebSocket(target);
          return lanSocket;
        },
      });
      const lanSeen = rawMessages(lanSocket);
      assert.deepEqual(
        await lan.transport.invoke("test:echo", bigValue),
        bigValue,
      );
      assert.equal(
        lanSeen[0].isBinary,
        false,
        "a LAN peer is never deflated for",
      );
      lan.close();

      // Tunnel-borne, but an old client whose hello carries no ask.
      const { client: old } = await authenticate(listener, {
        headers: TUNNEL_HEADERS,
      });
      old.send({ t: "req", id: 1, channel: "test:echo", input: bigValue });
      // The helper JSON-parses every message, so a binary frame
      // would have thrown there.
      assert.deepEqual((await old.nextFrame()).result, bigValue);
      old.close();
    },
  );

  await check(
    "deflate: a deflated frame sent in the same tick as the welcome is read, not lost",
    async (track) => {
      const url = await fakeHost(track, {
        afterWelcome: (ws) => {
          ws.send(
            deflatedFrame({
              t: "push",
              channel: "test:ping",
              payload: bigValue,
            }),
          );
          ws.send(encodeFrame({ t: "push", channel: "test:ping", payload: 2 }));
        },
      });
      const pushes = [];
      const connection = await dial(url, FAKE_TICKET, {
        onAnyPush: (_channel, payload) => pushes.push(payload),
        openSocket: (target) => new WebSocket(target),
      });
      track(() => connection.close());
      await waitFor(() => pushes.length === 2, "both pushes");
      assert.deepEqual(pushes, [bigValue, 2], "in the order they were sent");
    },
  );

  await check(
    "deflate: a frame that fails to inflate closes the connection, so the invoke it answered rejects instead of hanging",
    async (track) => {
      const url = await fakeHost(track, {
        onFrame: (ws) => {
          ws.send(
            Buffer.concat([
              Buffer.from([DEFLATED_FRAME_KIND]),
              Buffer.from("not a deflate stream at all"),
            ]),
          );
        },
      });
      let closedWith;
      const connection = await dial(url, FAKE_TICKET, {
        onClose: (code) => {
          closedWith = code;
        },
        openSocket: (target) => new WebSocket(target),
      });
      track(() => connection.close());
      await assert.rejects(
        () => connection.transport.invoke("test:echo", { hi: 1 }),
        /remote device disconnected/,
      );
      assert.equal(
        closedWith,
        null,
        "the owner was told, like a heartbeat death",
      );
    },
  );

  done();
}

main().catch(fail);
