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
// v2 step 6, slice B adds the LAN read-only gate: the LAN wire serves
// ONLY channels explicitly registered mutating:false, refusing a
// mutating or untagged channel with the shared command-refused code
// BEFORE its handler runs. The client transport maps that code to the
// typed CommandRefusedError, the preflight remoteAccess:commandAccess
// answers granted:false over this wire, and the contract spot-checks
// pin the step-6 flips (fs, the projects and packageScripts preference
// writes, globalConfig.writeDeviceSettings with its strict patch schema
// that structurally rejects socketHost and remoteDevices).
//
// Runs under scripts/lib/register-ts-alias.mjs so the app's TypeScript
// imports resolve. See package.json "socket:check".
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_HELLO_FAILED,
  COMMAND_REFUSED_CODE,
  CommandRefusedError,
  encodeFrame,
} from "@shared/ipc/socket/frames";
import { connectDevice } from "@shared/ipc/socket/wsClientTransport";
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

const TOKEN = "correct-horse-battery-staple-token-of-good-length";
const WS_CLOSE_TOO_BIG = 1009;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    "registrar: onMutationResolved fires after a mutating invoke resolves, never for reads or failures",
    async () => {
      // The remote-viewer externalChange ping (main/ipc/register.ts)
      // hangs off this registrar hook, so pin its semantics at the seam
      // with an in-memory transport: the LAN wire refuses mutating
      // invokes outright, and the Electron+relay composite that
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
      });
      let resolved = 0;
      registerContract(
        pingContract,
        {
          mutate: async () => {},
          read: async () => {},
          failMutate: async () => {
            throw new Error("boom");
          },
        },
        server,
        {
          validateOutputs: true,
          onMutationResolved: () => {
            resolved += 1;
          },
        },
      );
      const ctx = {};
      await handlers.get("pingtest:read")(ctx, undefined);
      assert.equal(resolved, 0, "a read must not trip the mutation hook");
      await handlers.get("pingtest:mutate")(ctx, undefined);
      assert.equal(resolved, 1, "a resolved mutation must trip the hook");
      await assert.rejects(() =>
        handlers.get("pingtest:failMutate")(ctx, undefined),
      );
      assert.equal(resolved, 1, "a failed mutation must not trip the hook");
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
      for (const key of [
        "listDirectory",
        "scanForGitRepos",
        "isGitRepo",
        "stat",
        "listEntries",
      ]) {
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
      // The pull orchestrator (v2 step 7, slice C) is LOCAL-only: a
      // device's own renderer drives it, and it must never be servable
      // to a peer -- a remote:false host invoke is simply not
      // registered on either remote wire.
      assert.equal(syncContract.calls.pullWorktree.remote, false);
      assert.equal(syncContract.calls.pullWorktree.mutating, true);
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

  console.log(`\nsocket-host proof OK (${passed.length} assertions)`);
}

main().catch((error) => {
  console.error(`\nsocket-host proof FAILED: ${error?.message ?? error}`);
  process.exitCode = 1;
});
