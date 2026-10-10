// What the control ops read off the account and the peers (ops.ts):
// the roster, where each peer stands for a repo, their worktrees and
// the mirrors they run against this device, and where a send would
// clone.
import { homedir } from "node:os";
import {
  type ControlDevice,
  ControlError,
  type ControlPeerWorktree,
} from "@shigomori/contracts/modules/control";
import {
  type MirrorSession,
  mirrorContract,
} from "@shigomori/contracts/modules/mirror";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { runtimeContract } from "@shigomori/contracts/modules/runtime";
import type { SyncCloneInto } from "@shigomori/contracts/modules/sync";
import { cloneIntoOf, moveCloneParent } from "@shared/cloneDestination";
import { tildify } from "@shigomori/contracts/projectPaths";
import { isHubRefusal } from "@shigomori/contracts/hubApi";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";
import { isRealBranch, type Project } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import {
  peerEffects,
  peerWorktreesFor,
  thisDeviceId,
} from "@host/ipc/peerSync";
import * as Ops from "@host/lib/engineOps";
import { mirrorList } from "@host/mirror/sessions";
import { implSlot } from "@host/lib/util/implSlot";
import type { PeerEffects } from "@host/ipc/peerSync";
import type { Client } from "@shigomori/contracts/types";
import {
  listed,
  matchDevices,
  type Named,
  nameOf,
  namesOf,
  peersOf,
  type Running,
} from "./plan";

// The Electron layer injects the account at boot (main/ipc/handlers.ts):
// the device registry rides the stored credential, and which peers
// have a direct session up is the hub status snapshot's. The peers
// themselves are reached through host/ipc/peerSync.ts.
type ControlImpl = {
  // The account's device registry. Empty when signed out.
  listDevices: Effect.Effect<DeviceInfo[], unknown>;
  // The devices a direct session is established to (the only ones a
  // call can reach), each with whether it shares with this device and
  // runs its commands: the hub status snapshot's peerSharesData and
  // peerAcceptsCommands, the same reading the app's windows show.
  directPeers: Effect.Effect<Readonly<Record<string, DirectPeer>>>;
};

export type DirectPeer = {
  readonly sharesData: boolean;
  readonly acceptsCommands: boolean;
};

const { set: setControlImpl, get: requireImpl } = implSlot<ControlImpl>(
  "control op requested before setControlImpl ran",
);
export { setControlImpl };

// An ask that only informs an answer gets a probe's patience, the
// registry included: it is a hub round trip with no clock of its own.
const probe = <A, E, R>(asked: Effect.Effect<A, E, R>, late: () => A) =>
  asked.pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT_MS,
      orElse: () => Effect.sync(late),
    }),
  );

export const roster = Effect.gen(function* () {
  const devices = yield* requireImpl().listDevices.pipe(
    // A credential the hub no longer honors (the device was removed
    // from the account while the app held it) is the signed-out case
    // with a reason, not a raw hub error for the CLI to print.
    Effect.mapError((error) =>
      isHubRefusal(error)
        ? new ControlError(
            "signed-out",
            "This device's access to the account was removed. Sign in again from the app.",
          )
        : error,
    ),
  );
  const hereId = thisDeviceId();
  const here = devices.find((device) => device.deviceId === hereId);
  if (here === undefined) {
    return yield* Effect.fail(
      new ControlError(
        "signed-out",
        "This device isn't signed in to an account, so it has no other devices to reach. Sign in from the app first.",
      ),
    );
  }
  return {
    here: { deviceId: hereId, name: nameOf(here) } as Named,
    peers: peersOf(devices, hereId),
  };
});

// Where each peer stands for one repo, in the dialogs' three blocks
// (renderer/components/shared/deviceTargets.ts) but not their order:
// standingOf puts command access first, since a send without a
// checkout clones one. The checkout is read fresh off the peer and the
// command access off the status snapshot. A read leaves the access
// out, since reads are ungated. The wording is the CLI's, pinned by
// test/control.mts. The dialogs word the same blocks for their verbs.
export const standingsOf = (
  devices: DeviceInfo[],
  identity: string | null,
  { grant }: { grant: boolean },
) =>
  Effect.flatMap(requireImpl().directPeers, (direct) =>
    Effect.forEach(
      devices,
      (device) => standingOf(device, identity, direct[device.deviceId], grant),
      { concurrency: "unbounded" },
    ),
  );

// Sharing comes first: a device that isn't sharing serves nothing.
// Then command access: a send needs it whether or not the device holds
// the repo (without it, it clones the repo first), and a bring needs
// both.
const standingOf = (
  device: DeviceInfo,
  identity: string | null,
  // Undefined when no direct session is established.
  peer: DirectPeer | undefined,
  grant: boolean,
): Effect.Effect<ControlDevice> => {
  const base = {
    deviceId: device.deviceId,
    name: nameOf(device),
    platform: device.platform,
  };
  const offline = { ...base, block: "offline" as const };
  if (peer === undefined) return Effect.succeed(offline);
  if (!peer.sharesData) {
    return Effect.succeed({ ...base, block: "not-sharing" as const });
  }
  return probe(
    peerEffects(projectsContract, device.deviceId).list(),
    () => null,
  ).pipe(
    Effect.map((projects): ControlDevice => {
      if (projects === null) return offline;
      // A null identity never matches: it means this device couldn't
      // tell what repo this is, not "the same unknown repo".
      const held =
        identity === null
          ? undefined
          : projects.find(
              (project) =>
                project.identity === identity && project.pathExists !== false,
            );
      const holding = held === undefined ? {} : { projectId: held.id };
      if (grant && !peer.acceptsCommands) {
        return { ...base, ...holding, block: "no-grant" };
      }
      return held === undefined
        ? { ...base, block: "no-project" }
        : { ...base, ...holding };
    }),
    // The session dropped between the roster read and the ask.
    Effect.orElseSucceed(() => offline),
  );
};

// A checkout git can't read (its folder moved away) has no identity
// to match on, the same as one with no shared identity.
export const repoIdentityOf = (project: Project) =>
  Ops.repoIdentity(project.path).pipe(Effect.orElseSucceed(() => null));

// The peers a transfer of this repo could run against: the named one,
// or every one. Each comes back with its standing, blocked or not,
// beside the identity they were matched on.
export const candidates = Effect.fnUntraced(function* (
  project: Project,
  query: string | undefined,
  { grant }: { grant: boolean },
) {
  const { peers } = yield* roster;
  if (peers.length === 0) {
    return yield* Effect.fail(
      new ControlError(
        "no-device",
        "This account has no other device. Sign in to the app on another machine first.",
      ),
    );
  }
  let asked = peers;
  if (query !== undefined) {
    asked = matchDevices(peers, query);
    if (asked.length === 0) {
      return yield* Effect.fail(
        new ControlError(
          "no-device",
          `No device is named "${query}". The account's other devices: ${listed(namesOf(peers))}.`,
        ),
      );
    }
    if (asked.length > 1) {
      return yield* Effect.fail(
        new ControlError(
          "ambiguous-device",
          `"${query}" matches several devices: ${listed(namesOf(asked))}. Name one in full, or pass its id.`,
        ),
      );
    }
  }
  const identity = yield* repoIdentityOf(project);
  return {
    identity,
    standings: yield* standingsOf(asked, identity, { grant }),
  };
});

export const registryOrEmpty = probe(requireListDevices(), () => []).pipe(
  Effect.orElseSucceed((): DeviceInfo[] => []),
);

function requireListDevices() {
  return Effect.suspend(() => requireImpl().listDevices);
}

// A session a peer runs against one of this device's worktrees, with
// the peer and the client to drive it through.
export type PeerMirror = Running & {
  api: PeerEffects<Client<typeof mirrorContract>>;
};

// The sessions peers run against this device's worktrees, found by
// asking each connected peer of the registry for its list (a read,
// ungated). A peer that does not answer in a probe's time, or whose
// session drops mid-ask, holds nothing this device can drive anyway.
// Signed out, the registry is empty, so the answer is empty rather
// than a refusal: the device's own sessions were already looked at.
export const peerMirrors = (registry: DeviceInfo[]) =>
  Effect.gen(function* () {
    const hereId = thisDeviceId();
    const direct = yield* requireImpl().directPeers;
    const peers = peersOf(registry, hereId).filter(
      (device) => direct[device.deviceId]?.sharesData === true,
    );
    const found = yield* Effect.forEach(
      peers,
      (device) => {
        const api = peerEffects(mirrorContract, device.deviceId);
        return probe(api.list(), () => null).pipe(
          Effect.map((list): PeerMirror[] =>
            list === null
              ? []
              : list.sessions
                  .filter((session) => session.deviceId === hereId)
                  .map((session) => ({
                    deviceId: device.deviceId,
                    session,
                    api,
                  })),
          ),
          Effect.orElseSucceed((): PeerMirror[] => []),
        );
      },
      { concurrency: "unbounded" },
    );
    return found.flat();
  });

export const peerMirrorOf = (
  target: { projectId: string; worktreeId: string },
  registry: Effect.Effect<DeviceInfo[]>,
) =>
  Effect.map(Effect.flatMap(registry, peerMirrors), (mirrors) =>
    mirrors.find(
      ({ session }) =>
        session.projectId === target.projectId &&
        session.worktreeId === target.worktreeId,
    ),
  );

// The mirror one of this device's worktrees is the original of, among
// the sessions this device runs (a copy here is a peer's session).
export const mirrorOf = (target: { projectId: string; worktreeId: string }) =>
  Effect.map(mirrorList(), ({ sessions }): MirrorSession | undefined =>
    sessions.find(
      (candidate) =>
        candidate.localProjectId === target.projectId &&
        candidate.localWorktreeId === target.worktreeId,
    ),
  );

// Where a send clones the repo on a device with no checkout of it, as
// the dialogs' review defaults it (shared/cloneDestination.ts): the
// source's own layout with this device's home swapped for the
// target's, or where the target keeps its repos. `parent` is the
// caller's pick, a path under this device's home read as the same path
// under the target's, the way the default is. The target's home and
// projects are its own answers, over the grant the send needs anyway.
export const cloneIntoOn = (
  deviceId: string,
  project: Project,
  parent: string | undefined,
) => {
  const here = homedir();
  if (parent !== undefined) {
    return Effect.succeed<SyncCloneInto>(
      cloneIntoOf(tildify(parent, here), project.path),
    );
  }
  return Effect.map(
    Effect.all(
      [
        peerEffects(runtimeContract, deviceId).info(),
        peerEffects(projectsContract, deviceId).list(),
      ],
      { concurrency: 2 },
    ),
    ([info, projects]): SyncCloneInto =>
      cloneIntoOf(
        moveCloneParent({
          sourcePath: project.path,
          sourceHome: here,
          destinationHome: info.homedir,
          destinationProjects: projects,
        }),
        project.path,
      ),
  );
};

// Every worktree of the repo that could move, on the peers that hold
// it, beside the peers that hold it and did not answer. A
// blocked-for-commands peer still lists (reads are ungated), so a bring
// can say which device to unblock. A worktree with no branch of its own
// can't be moved (sync:sendWorktree refuses one the same way). A
// primary is listed: a mirror can take it, and a bring says why not.
export const worktreesOn = (standings: ControlDevice[]) =>
  Effect.gen(function* () {
    const unanswered: ControlDevice[] = [];
    const lists = yield* Effect.forEach(
      standings,
      (device) => {
        const { projectId } = device;
        if (projectId === undefined) {
          return Effect.succeed([] as ControlPeerWorktree[]);
        }
        return probe(
          peerWorktreesFor(device.deviceId).list({ projectId }),
          () => null,
        ).pipe(
          Effect.flatMap((answer) =>
            answer === null ? Effect.fail("no answer") : Effect.succeed(answer),
          ),
          Effect.map((answer) =>
            answer
              .filter(
                (worktree) =>
                  !worktree.detached && isRealBranch(worktree.branch),
              )
              .map(
                (worktree): ControlPeerWorktree => ({
                  device: { deviceId: device.deviceId, name: device.name },
                  projectId,
                  worktree,
                }),
              ),
          ),
          Effect.catch(() =>
            Effect.sync(() => {
              unanswered.push(device);
              return [] as ControlPeerWorktree[];
            }),
          ),
        );
      },
      { concurrency: "unbounded" },
    );
    return { worktrees: lists.flat(), unanswered };
  });

// Which devices have a direct session up, each with whether it runs
// this device's commands.
export const directPeers = Effect.suspend(() => requireImpl().directPeers);
