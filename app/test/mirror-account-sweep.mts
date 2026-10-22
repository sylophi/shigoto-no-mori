// Proof for the sweep of the mirror sessions a host's daemon brings
// back for a device on no account (host/process/handlers.ts
// noAccountSweep, host/mirror/registry.ts createNoAccountSweep), on the
// host's own wiring: the account as HostAccount holds it, the shell's
// reports through applyAccount, the daemon's changes through
// mirrorDaemonChangesLayer, behind the graph's door. Each check starts a
// host the way a start, or a restart under a running shell, does: the
// daemon resumes its persisted sessions before the shell's first account
// report lands. The daemon and the engine over it are stand-ins whose
// sessions the check lists and whose ends it records.
//
// Asserts:
//   - a host started again under a running shell keeps the live
//     sessions its daemon reports before the first report, and after a
//     first report signed in,
//   - a sign-out then ends them, each thread saying this device left
//     the account, and a session the daemon reports after it is ended
//     too,
//   - a host that starts signed out ends what its daemon brought back
//     at the first report, and across a daemon restart ends nothing off
//     the snapshot that stands from the last run, only what the next
//     run lists.
//
// Run: pnpm test mirror-account-sweep.
import assert from "node:assert/strict";
import type { MirrorSessionRaw } from "@shigomori/contracts/modules/mirror";
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import * as MirrorInvites from "@shigomori/engine/MirrorInvites";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { it, vi } from "vitest";
import * as HostAccount from "@host/lib/HostAccount";
import * as MirrorDaemon from "@host/mirror/MirrorDaemon";
import { MirrorEngine } from "@host/mirror/MirrorEngine";
import {
  endMirrorsWithPeers,
  LEFT_ACCOUNT_DETAIL,
} from "@host/mirror/registry";
import * as Graph from "@host/process/graph";
import { settleTurns, waitFor } from "./lib/checkKit.mts";
import { inertMirrorImpl, rawMirrorSession } from "./lib/mirrorFakes.mts";
import { trackTest } from "./lib/vitestKit.mts";

// The hub socket and the listener are hub-link's and direct-plane's.
vi.mock("@host/process/wires", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshHubConnection: async () => {},
}));

const { applyAccount, mirrorDaemonChangesLayer } =
  await import("@host/process/handlers");

const SIGNED_IN: AccountFacts = {
  hubUrl: "http://127.0.0.1:1",
  accountId: "account",
  credential: "credential",
  deviceKey: "key",
  webOrigin: "",
  acceptsCommands: true,
};

const live = (session: string): MirrorSessionRaw =>
  rawMirrorSession({
    session,
    deviceId: "peer",
    localWorktreeId: `wt-${session}`,
  });

const notHere = () => Effect.die("not in this check");

// A host up over a daemon whose sessions and freshness the check sets.
async function startHost() {
  let sessions: MirrorSessionRaw[] = [];
  let fresh = false;
  const ended: string[] = [];
  const notes: string[] = [];
  const changes = Effect.runSync(PubSub.unbounded<void>({ replay: 1 }));
  const noInvites = MirrorInvites.MirrorInvites.of({
    load: Effect.succeed([]),
    save: () => Effect.void,
  });
  const terminate = (session: string) =>
    Effect.sync(() => {
      ended.push(session);
      sessions = sessions.filter((raw) => raw.session !== session);
      return session;
    });
  const engine: MirrorEngine["Service"] = inertMirrorImpl({
    sessions: Effect.sync(() => sessions),
    fresh: Effect.sync(() => fresh),
    terminate,
    noteEvent: (worktreeId, kind, detail) => {
      notes.push(`${worktreeId} ${kind}: ${detail}`);
    },
    leaveAccount: Effect.suspend(() =>
      endMirrorsWithPeers(() => false, LEFT_ACCOUNT_DETAIL, {
        transfers: true,
      }).pipe(
        Effect.provideService(MirrorEngine, engine),
        Effect.provideService(MirrorInvites.MirrorInvites, noInvites),
      ),
    ),
  });
  const daemon = MirrorDaemon.MirrorDaemon.of({
    status: engine.status,
    failure: engine.failure,
    sessions: engine.sessions,
    fresh: engine.fresh,
    changes: Stream.fromPubSub(changes),
    create: notHere,
    terminate,
    pause: notHere,
    resume: notHere,
  });
  // The graph needs only these here; what else it holds no call reaches.
  const graph = Graph.layer as Layer.Layer<
    never,
    never,
    HostAccount.HostAccount | MirrorDaemon.MirrorDaemon | MirrorEngine
  >;
  const runtime = ManagedRuntime.make(
    graph.pipe(
      Layer.provideMerge(mirrorDaemonChangesLayer),
      Layer.provideMerge(
        Layer.mergeAll(
          HostAccount.layer,
          Layer.succeed(MirrorDaemon.MirrorDaemon, daemon),
          Layer.succeed(MirrorEngine, engine),
        ),
      ),
    ),
  );
  trackTest(() => runtime.dispose());
  await runtime.runPromise(Effect.void);
  return {
    ended,
    notes,
    // The daemon's snapshot: the sessions it lists, and whether they
    // are its running child's own.
    snapshot: async (next: MirrorSessionRaw[], own = true) => {
      sessions = next;
      fresh = own;
      PubSub.publishUnsafe(changes, undefined);
      await settleTurns();
    },
    report: async (facts: AccountFacts | null) => {
      await applyAccount(facts);
      await settleTurns();
    },
  };
}

it("a host started again under a running shell keeps its mirrors, and a sign-out ends them", async () => {
  const host = await startHost();
  await host.snapshot([live("a-1"), live("a-2")]);
  assert.deepEqual(
    host.ended,
    [],
    "the sessions ended before the shell said this device's account",
  );
  await host.report(SIGNED_IN);
  await host.snapshot([live("a-1"), live("a-2")]);
  assert.deepEqual(host.ended, [], "a host signed in ended its mirrors");

  await host.report(null);
  assert.deepEqual(host.ended.toSorted(), ["a-1", "a-2"]);
  assert.deepEqual(host.notes.toSorted(), [
    `wt-a-1 stopped: ${LEFT_ACCOUNT_DETAIL}`,
    `wt-a-2 stopped: ${LEFT_ACCOUNT_DETAIL}`,
  ]);
  // Resumed by a daemon that was down at the sign-out.
  await host.snapshot([live("a-3")]);
  await waitFor(
    () => host.ended.includes("a-3"),
    "a session reported after the sign-out to end",
  );
});

it("a host that starts signed out ends what its daemon brings back", async () => {
  const host = await startHost();
  await host.snapshot([live("b-1")]);
  assert.deepEqual(
    host.ended,
    [],
    "the sessions ended before the shell said this device's account",
  );
  await host.report(null);
  await waitFor(
    () => host.ended.includes("b-1"),
    "the first report, signed out, to end what the daemon brought back",
  );

  // The daemon restarted: its last snapshot stands, then the next run's.
  await host.snapshot([live("b-2")], false);
  assert.deepEqual(host.ended, ["b-1"], "a stale snapshot ended a session");
  await host.snapshot([live("b-2")]);
  await waitFor(
    () => host.ended.includes("b-2"),
    "the next run's own snapshot to end what it brought back",
  );
  assert.deepEqual(host.ended, ["b-1", "b-2"]);
});
