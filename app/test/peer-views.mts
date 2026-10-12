// Durable proof for a peer's views when it cannot be reached
// (renderer/lib/runtime/atoms.ts, hostViewAtom), over a stand-in hub
// link whose peer has no session:
//   - a peer that never showed a value gives up after its tries with no
//     session to it (about eight seconds), so the sidebar reads it empty
//     and says so, as v2's queries did, rather than loading for good,
//   - a peer that showed rows and then lost its session keeps them, and
//     goes on asking,
//   - a peer that refuses (its sharing off) is asked again for good, since
//     a switch may flip back,
//   - this machine's host is asked for good.
//
// Run: pnpm test peer-views.
import assert from "node:assert/strict";
import { callOf } from "@shigomori/contracts/contract";
import {
  NoDirectConnectionError,
  NotSharingError,
} from "@shigomori/contracts/errors";
import { hubContract } from "@shigomori/contracts/modules/hub";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import type { ContractModule } from "@shigomori/contracts/contract";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { it } from "vitest";
import type { Link } from "@shared/ipc/transport";
import {
  clientLinksAtom,
  hostViewAtom,
  localDeviceIdAtom,
} from "@/lib/runtime/atoms";
import { delay, waitFor } from "./lib/checkKit.mts";

const LOCAL = "this-mac";
const PEER = "studio";
const ROWS = [
  {
    id: "p1",
    name: "notes",
    path: "/Users/rin/notes",
    pathExists: true,
  },
];

// A registry over a host link and a hub link whose views fail as a peer
// with no session does, after `peerAnswers` subscriptions that answered.
function page({
  peerAnswers = 0,
  hostFails = false,
  peerRefuses = false,
} = {}) {
  let peerAsks = 0;
  let hostAsks = 0;
  const noSession = new NoDirectConnectionError({ deviceId: PEER });
  const link = (local: boolean): Link => ({
    local,
    call: () => Effect.die(new Error("no calls here")),
    pushes: () => Stream.never,
    view: () => {
      if (local) {
        hostAsks += 1;
        return hostFails ? Stream.fail(noSession) : Stream.make(ROWS);
      }
      peerAsks += 1;
      if (peerRefuses) return Stream.fail(new NotSharingError());
      return peerAsks <= peerAnswers
        ? Stream.concat(Stream.make(ROWS), Stream.fail(noSession))
        : Stream.fail(noSession);
    },
  });
  const hostLink = link(true);
  const hubLink = link(false);
  const registry = AtomRegistry.make({
    initialValues: [
      [
        clientLinksAtom,
        {
          linkOf: (module: ContractModule) =>
            module === hubContract ? hubLink : hostLink,
        },
      ],
      [localDeviceIdAtom, LOCAL],
    ],
  });
  return {
    registry,
    peerAsks: () => peerAsks,
    hostAsks: () => hostAsks,
  };
}

const projectsOf = (deviceId: string) =>
  hostViewAtom({
    deviceId,
    view: callOf(projectsContract, "watch"),
    input: undefined,
  });

it("a peer never reached gives up after its tries, and reads as failed rather than loading", async () => {
  const { registry, peerAsks } = page();
  const atom = projectsOf(PEER);
  const unmount = registry.mount(atom);
  try {
    await waitFor(
      () => AsyncResult.isFailure(registry.get(atom)),
      "the view to give up",
      20_000,
    );
    const asked = peerAsks();
    assert.ok(asked >= 6, `asked ${asked} times`);
    // Past the longest wait between two asks (two seconds).
    await delay(2_500);
    assert.equal(peerAsks(), asked, "it asks no more once it gave up");
  } finally {
    unmount();
  }
}, 30_000);

it("a peer that showed rows keeps them through a lost session, and goes on asking", async () => {
  const { registry, peerAsks } = page({ peerAnswers: 1 });
  const atom = projectsOf(PEER);
  const unmount = registry.mount(atom);
  try {
    await waitFor(
      () => AsyncResult.isSuccess(registry.get(atom)),
      "the peer's rows",
    );
    await waitFor(
      () => peerAsks() > 8,
      "asks past the never-reached tries",
      20_000,
    );
    const result = registry.get(atom);
    assert.ok(!AsyncResult.isFailure(result), "it never gives up");
    assert.deepEqual(
      AsyncResult.getOrElse(result, () => null),
      ROWS,
    );
  } finally {
    unmount();
  }
}, 30_000);

it("a peer that refuses is asked again for good", async () => {
  const { registry, peerAsks } = page({ peerRefuses: true });
  const atom = projectsOf(PEER);
  const unmount = registry.mount(atom);
  try {
    // 2, 4 and 8 seconds apart on the refusal ladder.
    await waitFor(() => peerAsks() >= 4, "asks past a few refusals", 25_000);
    assert.ok(!AsyncResult.isFailure(registry.get(atom)), "it never gives up");
  } finally {
    unmount();
  }
}, 30_000);

it("this machine's host is asked for good", async () => {
  const { registry, hostAsks } = page({ hostFails: true });
  const atom = projectsOf(LOCAL);
  const unmount = registry.mount(atom);
  try {
    await waitFor(() => hostAsks() > 8, "asks past a peer's tries", 20_000);
    assert.ok(!AsyncResult.isFailure(registry.get(atom)));
  } finally {
    unmount();
  }
}, 30_000);
