// Durable proof for the calls a link has in flight: the client's gate
// (rpcLink's fifoGate, shared/remote/rpcTransport.ts) and the host's
// cap (MAX_IN_FLIGHT_PER_PEER, host/socket/DeviceLink.ts), over the
// REAL loopback (host/socket/Loopback.ts) a window's link dials. The
// client is the window's own pieces on one socket: an RpcClient on
// LoopbackGroup said hello on with the loopback's token, the REAL
// rpcLink over it (what dialDevice hands hostLink), and the renderer's
// runner (a FiberSet's runPromise, Api.ts's `run`). The bare RpcClient
// beside the link is the same connection with no gate in front, so the
// host's count on it can be filled to the cap and read back. Asserts:
//   - a fetch a query supersedes stops the host's work: the REAL
//     worktrees:changeStatus handler (host/ipc/modules/worktrees.ts),
//     on a project the terminal sm registered, runs a `git status` a
//     fake fsmonitor hook holds; the query's refetch, run with React
//     Query's signal, is cancelled by the next invalidateQueries as a
//     push would (cancelRefetch, which spares a query's first fetch,
//     so it has answered once before), and that git and its hook are
//     gone while the new fetch answers. The connection then takes all 64 calls the cap
//     allows, so the cancelled call's place came back.
//   - calls dropped while their host cleanup still runs (a killed git
//     not yet gone) free their places as they are dropped: as many
//     new calls made at once all run, and none is refused.
//   - a burst of 300 calls on the link all answer, with no refusal: the
//     host never runs more than LINK_CALLS_IN_FLIGHT (48) at once, and
//     starts them in the order they were made.
//   - with the cap full, the link's ping still answers, while one more
//     call is refused.
//
// No timer is involved: every wait is on a condition (waitFor).
//
// Run: pnpm test in-flight.
//
// covers: app/shared/remote/rpcTransport.ts
// covers: app/host/socket/DeviceLink.ts
import { LOOPBACK_FILE } from "@shigomori/engine/Control";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";
import { afterAll, beforeAll, it } from "vitest";
import { LoopbackGroup } from "@shigomori/contracts/link";
import { gitContract } from "@shigomori/contracts/modules/git";
import { worktreesContract } from "@shigomori/contracts/modules/worktrees";
import { PROTOCOL_VERSION } from "@shigomori/contracts/protocol";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import { worktreeIdFromPath } from "@shigomori/engine/worktreeLayout";
import * as Views from "@host/lib/Views";
import type { LinkRegistrar } from "@host/socket/DeviceLink";
import * as Loopback from "@host/socket/Loopback";
import * as StoreChanges from "@shigomori/engine/StoreChanges";
import { effectClient } from "@shared/ipc/effectClient";
import { createServed } from "@shared/ipc/served";
import { MAX_IN_FLIGHT_PER_PEER } from "@shared/remote/link";
import {
  type FlatClient,
  LINK_CALLS_IN_FLIGHT,
  rpcLink,
} from "@shared/remote/rpcTransport";
import { processAlive, waitFor } from "./lib/checkKit.mts";
import { cliSandbox } from "./lib/cliSandbox.mts";
import { hostContext } from "./lib/hostRuntime.mts";
import { pushesLayer } from "./lib/hostStandIns.mts";
import { trackTest } from "./lib/vitestKit.mts";

const fixture = cliSandbox("sm-in-flight-");
const { sandbox, dataDir, git, initRepo, commitFile, projectIdOf } = fixture;

// The calls a proof's handler holds open: the order they started in,
// how many run now and the most that ever ran at once, and how to let
// the ones held go.
const held = {
  order: [] as string[],
  running: 0,
  peak: 0,
  releases: [] as (() => void)[],
};
// A "stuck" call's cleanup, once interrupted, waits as well, as a
// killed git's exit does, until let go.
const cleanups: (() => void)[] = [];
const resetHeld = () => {
  held.order = [];
  held.running = 0;
  held.peak = 0;
  held.releases = [];
};
const releaseHeld = () => {
  for (const release of held.releases.splice(0)) release();
  for (const release of cleanups.splice(0)) release();
};

// A call that runs until released, counting itself in and out, on a
// real contract call (git:refreshProject, its projectId naming it).
const hold = ({ projectId }: { projectId: string }) =>
  Effect.suspend(() => {
    held.order.push(projectId);
    held.running += 1;
    held.peak = Math.max(held.peak, held.running);
    return Effect.callback<void>((resume) => {
      held.releases.push(() => resume(Effect.void));
    });
  }).pipe(
    Effect.onInterrupt(() =>
      projectId.startsWith("stuck")
        ? Effect.callback<void>((resume) => {
            cleanups.push(() => resume(Effect.void));
          })
        : Effect.void,
    ),
    Effect.ensuring(Effect.sync(() => (held.running -= 1))),
  );

// The slow git: an fsmonitor hook that holds the `git status` the
// changes page runs (--untracked-files=all, read off its parent's
// command line, so the engine's own git passes) while SLOW exists,
// leaving `<git pid> <hook pid>` in PIDS. Otherwise it fails, and git
// scans the tree itself.
const hookDir = join(sandbox, "fsmonitor");
const SLOW = join(hookDir, "slow");
const PIDS = join(hookDir, "pids");
const HOOK = join(hookDir, "hook");

let repo = "";
let projectId = "";
let loopback: { port: number; token: string } | undefined;
let stopLoopback: (() => Promise<void>) | undefined;

beforeAll(async () => {
  await fixture.buildSm();
  await fixture.useCli();
  mkdirSync(PIDS, { recursive: true });
  writeFileSync(
    HOOK,
    `#!/bin/sh
case "$(ps -o args= -p $PPID)" in
  *untracked-files=all*)
    if [ -e '${SLOW}' ]; then
      echo "$PPID $$" > '${PIDS}'/$$
      exec sleep 600
    fi ;;
esac
exit 1
`,
    { mode: 0o755 },
  );
  repo = await initRepo("project");
  await commitFile(repo, "a.txt", "a\n", "seed");
  await git(repo, ["config", "core.fsmonitor", HOOK]);
  projectId = await projectIdOf(repo);

  // The REAL loopback, serving the changes page's REAL handler and the
  // proof's held call, on the file's host services.
  const registrar: LinkRegistrar = createServed();
  registrar.serveOne(
    worktreesContract,
    "changeStatus",
    worktreesHandlers.changeStatus,
  );
  registrar.serveOne(gitContract, "refreshProject", hold);
  const host = await hostContext();
  const scope = Scope.makeUnsafe();
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      Loopback.layer({
        registrar,
        deviceId: () => "this-device",
        appVersion: "9.9.9",
        file: () => join(dataDir, LOOPBACK_FILE),
        services: Effect.succeed(host),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreChanges.layer, pushesLayer, Views.layer).pipe(
            Layer.provideMerge(Layer.succeedContext(host)),
          ),
        ),
      ),
      scope,
    ) as Effect.Effect<Context.Context<Loopback.Loopback>, never, never>,
  );
  const address = await Effect.runPromise(
    Context.get(context, Loopback.Loopback).address,
  );
  loopback = { port: address.port, token: address.token };
  stopLoopback = () => Effect.runPromise(Scope.close(scope, Exit.void));
});

afterAll(async () => {
  // A hook a failed check left sleeping.
  for (const pid of slowPids()) if (processAlive(pid)) process.kill(pid);
  await stopLoopback?.();
  await fixture.remove();
});

// The pids of every held git status and its hook.
function slowPids(): number[] {
  if (!existsSync(PIDS)) return [];
  return readdirSync(PIDS).flatMap((file) =>
    readFileSync(join(PIDS, file), "utf8").trim().split(" ").map(Number),
  );
}

// A window's link on the loopback, as dialDevice makes it: hello'd
// with the token, the REAL rpcLink over its RpcClient, and the
// renderer's runner. `raw` is the same connection's RpcClient with no
// gate in front. Closed as the test ends.
async function openLink() {
  assert.ok(loopback !== undefined, "the loopback is up");
  const { port, token } = loopback;
  const scope = Scope.makeUnsafe();
  trackTest(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  return Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}`);
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerSchemaBinary()),
      );
      // oxlint-disable-next-line shigomori/no-double-cast -- the group's calls are typed only as Rpc.AnyWithProps
      const client = (yield* RpcClient.make(LoopbackGroup, {
        flatten: true,
      }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      )) as unknown as FlatClient;
      const raw = (tag: string, payload?: unknown) =>
        client(tag, payload) as Effect.Effect<unknown, unknown>;
      yield* raw("link:hello", {
        deviceId: "this-device",
        deviceKind: "desktop",
        connectionId: "c".repeat(32),
        appVersion: "9.9.9",
        protocolVersion: PROTOCOL_VERSION,
        token,
      });
      const link = yield* rpcLink({ client, group: LoopbackGroup });
      const run = yield* FiberSet.makeRuntimePromise<never>();
      return { link, raw, run };
    }).pipe(
      Scope.provide(scope),
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    ),
  );
}

type OpenLink = Awaited<ReturnType<typeof openLink>>;

// Holds MAX_IN_FLIGHT_PER_PEER calls on the connection, past the gate:
// every one runs only if the host counted none in flight before. One
// more is refused, so the cap is where it was.
async function fillCap({ raw, run }: OpenLink) {
  const calls = Array.from({ length: MAX_IN_FLIGHT_PER_PEER }, (_, n) =>
    run(raw("git:refreshProject", { projectId: `fill${n}` })),
  );
  trackTest(async () => {
    releaseHeld();
    await Promise.allSettled(calls);
  });
  await waitFor(
    () => held.running === MAX_IN_FLIGHT_PER_PEER,
    "every call under the cap to run",
  );
  const over = await run(
    Effect.flip(raw("git:refreshProject", { projectId: "over" })),
  );
  assert.match(String(over), /too many in-flight requests/);
  return calls;
}

it("superseded: a fetch a query's refetch cancels stops the host's git, and its place under the cap comes back", async () => {
  resetHeld();
  const connection = await openLink();
  const worktrees = effectClient(worktreesContract, connection.link);
  const input = { projectId, worktreeId: worktreeIdFromPath(repo) };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  trackTest(() => queryClient.clear());
  const observer = new QueryObserver(queryClient, {
    queryKey: ["changeStatus"],
    queryFn: ({ signal }) =>
      connection.run(worktrees.changeStatus(input), { signal }),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["changeStatus"] });
  trackTest(observer.subscribe(() => {}));
  await waitFor(
    () => observer.getCurrentResult().status === "success",
    "the first fetch",
  );

  // A push's invalidation, while git is held: the refetch runs a git
  // status that does not answer.
  writeFileSync(SLOW, "");
  trackTest(() => rmSync(SLOW, { force: true }));
  void invalidate();
  await waitFor(() => slowPids().length === 2, "the held git status");
  const [gitPid = 0, hookPid = 0] = slowPids();
  assert.ok(processAlive(gitPid) && processAlive(hookPid));

  // The next push's, its default cancelRefetch: the fetch under way is
  // cancelled and a new one made, which runs git at speed.
  rmSync(SLOW);
  await invalidate();
  const result = observer.getCurrentResult();
  assert.equal(result.status, "success", String(result.error));
  assert.deepEqual(result.data, []);
  // The first fetch and the last landed, the superseded one never.
  assert.equal(queryClient.getQueryState(["changeStatus"])?.dataUpdateCount, 2);
  await waitFor(
    () => !processAlive(gitPid) && !processAlive(hookPid),
    "the superseded git and its hook to end",
  );
  assert.equal(slowPids().length, 2, "only the superseded git was held");

  await fillCap(connection);
});

it("dropped: calls cancelled while their host cleanup runs free their places at once, so as many new ones are all taken", async () => {
  resetHeld();
  const { link, run } = await openLink();
  const dropping = new AbortController();
  const dropped = Array.from({ length: LINK_CALLS_IN_FLIGHT }, (_, n) =>
    run(link.call("git:refreshProject", { projectId: `stuck${n}` }), {
      signal: dropping.signal,
    }).catch(() => undefined),
  );
  await waitFor(
    () => held.running === LINK_CALLS_IN_FLIGHT,
    "the calls to be dropped to run",
  );
  // A page going: every call dropped, and the next page's made at once.
  dropping.abort();
  const refusals: unknown[] = [];
  const next = Array.from({ length: LINK_CALLS_IN_FLIGHT }, (_, n) =>
    run(link.call("git:refreshProject", { projectId: `next${n}` })).catch(
      (error: unknown) => {
        refusals.push(error);
      },
    ),
  );
  trackTest(async () => {
    releaseHeld();
    await Promise.allSettled([...dropped, ...next]);
  });
  await waitFor(
    () =>
      held.order.filter((id) => id.startsWith("next")).length +
        refusals.length ===
      LINK_CALLS_IN_FLIGHT,
    "the next calls to reach the host or be refused",
  );
  assert.equal(
    refusals.length,
    0,
    `${refusals.length} refused: ${String(refusals[0])}`,
  );
  // The dropped calls' cleanup still runs on the host.
  assert.equal(cleanups.length, LINK_CALLS_IN_FLIGHT);
  releaseHeld();
  await Promise.all([...dropped, ...next]);
  await waitFor(() => held.running === 0, "the host's calls to drain");
});

it("burst: 300 calls on the link all answer, never more than the gate's at once on the host, started in the order they were made", async () => {
  resetHeld();
  const { link, run } = await openLink();
  const total = 300;
  let settled = 0;
  const refusals: unknown[] = [];
  const calls = Array.from({ length: total }, (_, n) =>
    run(link.call("git:refreshProject", { projectId: `b${n}` })).then(
      () => {
        settled += 1;
      },
      (error: unknown) => {
        settled += 1;
        refusals.push(error);
      },
    ),
  );
  trackTest(async () => {
    releaseHeld();
    await Promise.allSettled(calls);
  });
  // Each round, the host holds what reached it: as many as the gate
  // lets out, or all that are left. Then they are let go together.
  const unanswered = () => settled < total;
  while (unanswered()) {
    await waitFor(
      () =>
        held.running >= LINK_CALLS_IN_FLIGHT ||
        held.running + settled === total,
      "a round of calls to reach the host",
    );
    const answered = settled + held.releases.length;
    releaseHeld();
    await waitFor(() => settled >= answered, "the round to answer");
  }
  await Promise.all(calls);
  assert.equal(
    refusals.length,
    0,
    `${refusals.length} refused, the host's peak ${held.peak}: ${String(refusals[0])}`,
  );
  assert.equal(held.peak, LINK_CALLS_IN_FLIGHT);
  assert.deepEqual(
    held.order,
    Array.from({ length: total }, (_, n) => `b${n}`),
  );
});

it("full cap: with every place on a connection held, its ping still answers", async () => {
  resetHeld();
  const connection = await openLink();
  await fillCap(connection);
  await connection.run(connection.raw("link:ping"));
  assert.equal(held.running, MAX_IN_FLIGHT_PER_PEER);
});
