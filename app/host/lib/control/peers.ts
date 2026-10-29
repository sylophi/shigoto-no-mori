// What the control ops read off the account and the peers (ops.ts):
// the roster, where each peer stands for a repo, their worktrees and
// the mirrors they run against this device, and where a send would
// clone.
import { errorWordsOf } from "@host/lib/errorWords";
import {
  isHubRateLimitedError,
  isNoDirectConnectionError,
  isNotSharingError,
} from "@shigomori/contracts/errors";
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
import { byPlatform } from "@shigomori/engine/platform";
import type { SyncCloneInto } from "@shigomori/contracts/modules/sync";
import { cloneIntoOf, moveCloneParent } from "@shared/cloneDestination";
import { tildify } from "@shigomori/contracts/projectPaths";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { PROBE_TIMEOUT_MS } from "@shared/remote/link";
import { answerWithin } from "@shigomori/engine/liveness";
import { isRealBranch, type Project } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  type PeerReach,
  peerEffects,
  peerWorktreesFor,
} from "@host/ipc/PeerReach";
import * as DeviceId from "@host/lib/config/DeviceId";
import * as AccountPeers from "./AccountPeers";
import type { DirectPeer } from "./AccountPeers";
import * as Ops from "@host/lib/engineOps";
import { mirrorList } from "@host/mirror/sessions";
import type { PeerEffects } from "@host/ipc/PeerReach";
import {
  listed,
  matchDevices,
  type Named,
  nameOf,
  namesOf,
  peersOf,
  type Running,
} from "./plan";

// An ask that only informs an answer gets a probe's patience, the
// registry included: it is a hub round trip with no clock of its own.
// One whose limit came late (the host stopped) asks again before it
// says `late` (answerWithin): a peer that answered isn't offline.
const probe = <A, E, R>(asked: Effect.Effect<A, E, R>, late: () => A) =>
  answerWithin(asked, PROBE_TIMEOUT_MS).pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.sync(late), onSome: (exit) => exit }),
    ),
  );

export const signedOut = () =>
  new ControlError(
    "signed-out",
    `This device isn't signed in to an account, so it has no other devices to reach. ${byPlatform(
      {
        darwin: "Sign in from the app first.",
        linux: "Sign in first (`login`).",
      },
    )}`,
  );

export const roster = Effect.gen(function* () {
  const devices = yield* Effect.flatMap(
    AccountPeers.AccountPeers,
    (account) => account.listDevices,
  );
  const hereId = yield* DeviceId.current;
  const here = devices.find((device) => device.deviceId === hereId);
  if (here === undefined) return yield* Effect.fail(signedOut());
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
// out, since reads are ungated. The wording is the CLI's. The dialogs
// word the same blocks for their verbs.
export const standingsOf = (
  devices: DeviceInfo[],
  identity: string | null,
  { grant }: { grant: boolean },
) =>
  Effect.flatMap(directPeers, (direct) =>
    Effect.forEach(
      devices,
      (device) => standingOf(device, identity, direct[device.deviceId], grant),
      { concurrency: "unbounded" },
    ),
  );

// What a peer holds, read fresh, beside its standing: offline, not
// sharing, or a refusal in its words stand for the device whatever the
// repo (and leave its projects unread), then with `grant`, no command
// access.
const projectsOn = (
  device: DeviceInfo,
  // Undefined when no direct session is established.
  peer: DirectPeer | undefined,
  grant: boolean,
): Effect.Effect<
  { standing: ControlDevice; projects: Project[] | null },
  never,
  PeerReach
> => {
  const base = {
    deviceId: device.deviceId,
    name: nameOf(device),
    platform: device.platform,
  };
  const offline = {
    standing: { ...base, block: "offline" as const },
    projects: null,
  };
  if (peer === undefined) return Effect.succeed(offline);
  if (!peer.sharesData) {
    return Effect.succeed({
      standing: { ...base, block: "not-sharing" as const },
      projects: null,
    });
  }
  return probe(
    peerEffects(projectsContract, device.deviceId).list(),
    () => null,
  ).pipe(
    Effect.map((projects) =>
      projects === null
        ? offline
        : {
            standing:
              grant && peer.acceptsCommands !== true
                ? { ...base, block: "no-grant" as const }
                : base,
            projects: projects.filter(
              (project) => project.pathExists !== false,
            ),
          },
    ),
    // The session dropped between the roster read and the ask (the
    // bridge reads a drop as no direct connection), the peer stopped
    // sharing meanwhile, or it answered with a refusal, in its words.
    Effect.catch((error) =>
      Effect.succeed({
        standing: isNoDirectConnectionError(error)
          ? offline.standing
          : isNotSharingError(error)
            ? { ...base, block: "not-sharing" as const }
            : {
                ...base,
                block: "refused" as const,
                refusal: errorWordsOf(error),
              },
        projects: null,
      }),
    ),
  );
};

// Sharing comes first: a device that isn't sharing serves nothing.
// Then command access: a send needs it whether or not the device holds
// the repo (without it, it clones the repo first), and a bring needs
// both.
const standingOf = (
  device: DeviceInfo,
  identity: string | null,
  peer: DirectPeer | undefined,
  grant: boolean,
): Effect.Effect<ControlDevice, never, PeerReach> =>
  Effect.map(projectsOn(device, peer, grant), ({ standing, projects }) => {
    if (projects === null) return standing;
    // A null identity never matches: it means this device couldn't
    // tell what repo this is, not "the same unknown repo".
    const held =
      identity === null
        ? undefined
        : projects.find((project) => project.identity === identity);
    if (held !== undefined) return { ...standing, projectId: held.id };
    return standing.block === undefined
      ? { ...standing, block: "no-project" }
      : standing;
  });

// Each peer's projects, for a clone from one: its standing says
// whether it could serve one (a clone reads the peer's checkout over
// its grant).
export const projectsOnPeers = (devices: DeviceInfo[]) =>
  Effect.flatMap(directPeers, (direct) =>
    Effect.forEach(
      devices,
      (device) => projectsOn(device, direct[device.deviceId], true),
      { concurrency: "unbounded" },
    ),
  );

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
  const asked = yield* askedPeers(query);
  const identity = yield* repoIdentityOf(project);
  return {
    identity,
    standings: yield* standingsOf(asked, identity, { grant }),
  };
});

// The peers a verb asks: the one `query` names, or every one.
export const askedPeers = Effect.fnUntraced(function* (
  query: string | undefined,
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
          `"${query}" matches several devices: ${listed(namesOf(asked))}. Name one in full, or pass the start of its id.`,
        ),
      );
    }
  }
  return asked;
});

export const registryOrEmpty = probe(
  Effect.flatMap(AccountPeers.AccountPeers, (account) => account.listDevices),
  () => [],
).pipe(Effect.orElseSucceed((): DeviceInfo[] => []));

// The same, for a verb that decides on what it finds (a mirror a peer
// runs, or none): the hub's rate limit fails it, so the verb says that
// rather than that nothing is there.
export const registryUnlessRateLimited = probe(
  Effect.flatMap(AccountPeers.AccountPeers, (account) => account.listDevices),
  () => [],
).pipe(
  Effect.catch((error) =>
    isHubRateLimitedError(error)
      ? Effect.fail(error)
      : Effect.succeed<DeviceInfo[]>([]),
  ),
);

// A session a peer runs against one of this device's worktrees, with
// the peer and the client to drive it through.
export type PeerMirror = Running & {
  api: PeerEffects<typeof mirrorContract>;
};

// The sessions peers run against this device's worktrees, found by
// asking each connected peer of the registry for its list (a read,
// ungated). A peer that does not answer in a probe's time, or whose
// session drops mid-ask, holds nothing this device can drive anyway.
// Signed out, the registry is empty, so the answer is empty rather
// than a refusal: the device's own sessions were already looked at.
export const peerMirrors = (registry: DeviceInfo[]) =>
  Effect.gen(function* () {
    const hereId = yield* DeviceId.current;
    const direct = yield* directPeers;
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

export const peerMirrorOf = <E, R>(
  target: { projectId: string; worktreeId: string },
  registry: Effect.Effect<DeviceInfo[], E, R>,
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
// projects are its own answers.
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
export const directPeers = Effect.flatMap(
  AccountPeers.AccountPeers,
  (account) => account.directPeers,
);
