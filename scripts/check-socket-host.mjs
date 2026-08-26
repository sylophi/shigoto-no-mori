// Durable proof for the websocket host binding (host/socket/server.ts).
// Starts a real binding on an ephemeral loopback port and drives a real
// ws client against it, asserting the auth, dispatch, broadcast and
// framing paths PLUS the security behaviors the hardening added:
// terminate-on-bad-token, post-timeout hello rejection, oversized-frame
// rejection, Origin-bearing upgrade rejection, empty-token start
// refusal, the no-handler answer a non-remote channel gets, the
// per-socket in-flight cap, the stopped-listener generation guard, and
// the contract invariant that every host invoke is explicitly tagged
// remote true or false.
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "socket:check".
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_HELLO_FAILED,
  encodeFrame,
} from "@shared/ipc/socket/frames";
import { createWsServerBinding } from "@host/socket/server";
// Host contract modules, for the explicit-remote-tag invariant.
import { branchesContract } from "@shared/ipc/modules/branches";
import { cliContract } from "@shared/ipc/modules/cli";
import { fsContract } from "@shared/ipc/modules/fs";
import { gitContract } from "@shared/ipc/modules/git";
import { githubCliContract } from "@shared/ipc/modules/githubCli";
import { globalConfigContract } from "@shared/ipc/modules/globalConfig";
import { hygieneContract } from "@shared/ipc/modules/hygiene";
import { launchersContract } from "@shared/ipc/modules/launchers";
import { packageScriptsContract } from "@shared/ipc/modules/packageScripts";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import { projectsContract } from "@shared/ipc/modules/projects";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import { scriptsContract } from "@shared/ipc/modules/scripts";
import { shigomoriContract } from "@shared/ipc/modules/shigomori";
import { worktreesContract } from "@shared/ipc/modules/worktrees";

const TOKEN = "correct-horse-battery-staple-token-of-good-length";
const WS_CLOSE_TOO_BIG = 1009;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shared handler state referenced by registerTestHandlers. Reset by the
// tests that use it.
let hangResolvers = [];
let countExecutions = 0;

function registerTestHandlers(binding) {
  binding.handle("test:echo", async (_ctx, raw) => raw);
  binding.handle(
    "test:hang",
    () => new Promise((resolve) => hangResolvers.push(resolve)),
  );
  binding.handle("test:count", async () => {
    countExecutions += 1;
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

const passed = [];
async function check(name, fn) {
  await fn();
  passed.push(name);
  console.log(`  ok  ${name}`);
}

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
    "Origin gate: a handshake carrying an Origin header is rejected",
    async () => {
      const { binding, url } = await startBinding();
      try {
        const client = connect(url, { origin: "http://evil.example" });
        await assert.rejects(client.opened);
      } finally {
        await binding.stop();
      }
    },
  );

  await check(
    "in-flight cap: the 33rd concurrent request is refused rather than dispatched",
    async () => {
      hangResolvers = [];
      const { binding, url } = await startBinding();
      try {
        const { client } = await authenticate(url);
        // Fill the per-socket cap (32) with requests that never resolve,
        // then send one more.
        for (let id = 1; id <= 32; id += 1) {
          client.send({ t: "req", id, channel: "test:hang", input: undefined });
        }
        client.send({
          t: "req",
          id: 33,
          channel: "test:hang",
          input: undefined,
        });
        const res = await client.nextFrame();
        assert.equal(res.id, 33);
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
    "contract invariant: every host-scoped invoke is explicitly tagged remote true or false",
    async () => {
      const hostModules = {
        branches: branchesContract,
        cli: cliContract,
        fs: fsContract,
        git: gitContract,
        githubCli: githubCliContract,
        globalConfig: globalConfigContract,
        hygiene: hygieneContract,
        launchers: launchersContract,
        packageScripts: packageScriptsContract,
        portPool: portPoolContract,
        projects: projectsContract,
        runtime: runtimeContract,
        scripts: scriptsContract,
        shigomori: shigomoriContract,
        worktrees: worktreesContract,
      };
      for (const [name, module] of Object.entries(hostModules)) {
        assert.equal(module.scope, "host", `${name} is not host-scoped`);
        for (const [key, def] of Object.entries(module.calls)) {
          if (def.kind !== "invoke") continue;
          assert.equal(
            typeof def.remote,
            "boolean",
            `${name}.${key} (${def.channel}) is not explicitly tagged remote`,
          );
          // Every remote:true invoke also classifies itself as a command
          // or a read, so a new remote call cannot silently join the wire
          // without declaring whether the relay grant model must gate it.
          // remote:false invokes never reach the grant check, so theirs
          // may stay undefined.
          if (def.remote === true) {
            assert.equal(
              typeof def.mutating,
              "boolean",
              `${name}.${key} (${def.channel}) is remote but not explicitly tagged mutating`,
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
      assert.equal(globalConfigContract.calls.read.remote, true);
      assert.equal(worktreesContract.calls.create.remote, true);
      assert.equal(fsContract.calls.listDirectory.remote, false);
      // Spot-check the mutating classification so a read cannot silently
      // become a command (served ungated to every peer) or a command a
      // read (served ungated too).
      assert.equal(worktreesContract.calls.create.mutating, true);
      assert.equal(worktreesContract.calls.list.mutating, false);
      assert.equal(worktreesContract.calls.push.mutating, true);
      assert.equal(scriptsContract.calls.run.mutating, true);
      assert.equal(gitContract.calls.refreshProject.mutating, true);
      assert.equal(globalConfigContract.calls.read.mutating, false);
    },
  );

  console.log(`\nsocket-host proof OK (${passed.length} assertions)`);
}

main().catch((error) => {
  console.error(`\nsocket-host proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
