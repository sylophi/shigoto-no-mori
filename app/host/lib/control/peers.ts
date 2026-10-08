// What the control ops read off the account and the peers (ops.ts):
// the roster, where each peer stands for a repo, their worktrees and
// the mirrors they run against this device, and where a send would
// clone. An ask that only informs an answer gets a probe's patience
// (within).
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
import { tildify } from "@shared/projectPaths";
import type { HandlerContext } from "@shared/ipc/transport";
import { isHubRefusal } from "@shared/account/service";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import { PROBE_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import { isRealBranch, type Project } from "@shigomori/contracts/schemas";
import {
  peerClient,
  peerWorktreesApiFor,
  thisDeviceId,
} from "@host/ipc/peerSync";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import { mirrorHandlers } from "@host/ipc/modules/mirror";
import { implSlot } from "@host/lib/util/implSlot";
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
  listDevices: () => Promise<DeviceInfo[]>;
  // The devices a direct session is established to (the only ones a
  // call can reach), each with whether it runs this device's commands:
  // the hub status snapshot's peerAcceptsCommands, the same reading
  // the app's windows show.
  directPeers: () => Promise<Readonly<Record<string, boolean>>>;
};

const { set: setControlImpl, get: requireImpl } = implSlot<ControlImpl>(
  "control op requested before setControlImpl ran",
);
export { setControlImpl };

// An ask that only informs an answer gets a probe's patience: a peer
// whose session is up but whose app is wedged would otherwise hold a
// listing until the heartbeat gives up on it, and the registry is a
// hub round trip with no clock of its own.
async function within<T>(asked: Promise<T>, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      asked,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(late()), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function roster(): Promise<{ here: Named; peers: DeviceInfo[] }> {
  const { listDevices } = requireImpl();
  let devices: DeviceInfo[];
  try {
    devices = await listDevices();
  } catch (error) {
    // A credential the hub no longer honors (the device was removed
    // from the account while the app held it) is the signed-out case
    // with a reason, not a raw hub error for the CLI to print.
    if (!isHubRefusal(error)) throw error;
    throw new ControlError(
      "signed-out",
      "This device's access to the account was removed. Sign in again from the app.",
    );
  }
  const hereId = thisDeviceId();
  const here = devices.find((device) => device.deviceId === hereId);
  if (here === undefined) {
    throw new ControlError(
      "signed-out",
      "This device isn't signed in to an account, so it has no other devices to reach. Sign in from the app first.",
    );
  }
  return {
    here: { deviceId: hereId, name: nameOf(here) },
    peers: peersOf(devices, hereId),
  };
}

// Where each peer stands for one repo, in the dialogs' three blocks
// (renderer/components/shared/deviceTargets.ts) but not their order:
// standingOf puts command access first, since a send without a
// checkout clones one. The checkout is read fresh off the peer and the
// command access off the status snapshot. A read leaves the access
// out, since reads are ungated. The wording is the CLI's, pinned by
// test/control.mts. The dialogs word the same blocks for their verbs.
export async function standingsOf(
  devices: DeviceInfo[],
  identity: string | null,
  { grant }: { grant: boolean },
): Promise<ControlDevice[]> {
  const direct = await requireImpl().directPeers();
  return Promise.all(
    devices.map((device) =>
      standingOf(device, identity, direct[device.deviceId], grant),
    ),
  );
}

// Command access comes first: a send needs it whether or not the device
// holds the repo (without it, it clones the repo first), and a bring
// needs both.
async function standingOf(
  device: DeviceInfo,
  identity: string | null,
  // Undefined when no direct session is established.
  acceptsCommands: boolean | undefined,
  grant: boolean,
): Promise<ControlDevice> {
  const base = {
    deviceId: device.deviceId,
    name: nameOf(device),
    platform: device.platform,
  };
  const offline = { ...base, block: "offline" as const };
  if (acceptsCommands === undefined) return offline;
  try {
    const projects = await within(
      peerClient(projectsContract, device.deviceId).list(),
      () => null,
    );
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
    if (grant && !acceptsCommands) {
      return { ...base, ...holding, block: "no-grant" };
    }
    return held === undefined
      ? { ...base, block: "no-project" }
      : { ...base, ...holding };
  } catch {
    // The session dropped between the roster read and the ask.
    return offline;
  }
}

// A checkout git can't read (its folder moved away) has no identity
// to match on, the same as one with no shared identity.
export const repoIdentityOf = (project: Project): Promise<string | null> =>
  getRepoIdentity(project.path).catch(() => null);

// The peers a transfer of this repo could run against: the named one,
// or every one. Each comes back with its standing, blocked or not,
// beside the identity they were matched on.
export async function candidates(
  project: Project,
  query: string | undefined,
  { grant }: { grant: boolean },
): Promise<{ identity: string | null; standings: ControlDevice[] }> {
  const { peers } = await roster();
  if (peers.length === 0) {
    throw new ControlError(
      "no-device",
      "This account has no other device. Sign in to the app on another machine first.",
    );
  }
  let asked = peers;
  if (query !== undefined) {
    asked = matchDevices(peers, query);
    if (asked.length === 0) {
      throw new ControlError(
        "no-device",
        `No device is named "${query}". The account's other devices: ${listed(namesOf(peers))}.`,
      );
    }
    if (asked.length > 1) {
      throw new ControlError(
        "ambiguous-device",
        `"${query}" matches several devices: ${listed(namesOf(asked))}. Name one in full, or pass its id.`,
      );
    }
  }
  const identity = await repoIdentityOf(project);
  return { identity, standings: await standingsOf(asked, identity, { grant }) };
}

export async function registryOrEmpty(): Promise<DeviceInfo[]> {
  try {
    return await within(requireImpl().listDevices(), () => []);
  } catch {
    return [];
  }
}

// A session a peer runs against one of this device's worktrees, with
// the peer and the client to drive it through.
export type PeerMirror = Running & { api: ReturnType<typeof peerMirrorApi> };

function peerMirrorApi(deviceId: string) {
  return peerClient(mirrorContract, deviceId);
}

// The sessions peers run against this device's worktrees, found by
// asking each connected peer of the registry for its list (a read,
// ungated). A peer that does not answer in a probe's time, or whose
// session drops mid-ask, holds nothing this device can drive anyway.
// Signed out, the registry is empty, so the answer is empty rather
// than a refusal: the device's own sessions were already looked at.
export async function peerMirrors(
  registry: DeviceInfo[],
): Promise<PeerMirror[]> {
  const hereId = thisDeviceId();
  const direct = await requireImpl().directPeers();
  const peers = peersOf(registry, hereId).filter(
    (device) => direct[device.deviceId] !== undefined,
  );
  const found = await Promise.all(
    peers.map(async (device): Promise<PeerMirror[]> => {
      const api = peerMirrorApi(device.deviceId);
      try {
        const list = await within(api.list(), () => null);
        if (list === null) return [];
        return list.sessions
          .filter((session) => session.deviceId === hereId)
          .map((session) => ({ deviceId: device.deviceId, session, api }));
      } catch {
        return [];
      }
    }),
  );
  return found.flat();
}

export async function peerMirrorOf(
  target: { projectId: string; worktreeId: string },
  registry: Promise<DeviceInfo[]>,
): Promise<PeerMirror | undefined> {
  return (await peerMirrors(await registry)).find(
    ({ session }) =>
      session.projectId === target.projectId &&
      session.worktreeId === target.worktreeId,
  );
}

// The mirror one of this device's worktrees is the original of, among
// the sessions this device runs (a copy here is a peer's session).
export async function mirrorOf(
  ctx: HandlerContext,
  target: { projectId: string; worktreeId: string },
): Promise<MirrorSession | undefined> {
  const { sessions } = await mirrorHandlers.list(undefined, ctx);
  return sessions.find(
    (candidate) =>
      candidate.localProjectId === target.projectId &&
      candidate.localWorktreeId === target.worktreeId,
  );
}

// Where a send clones the repo on a device with no checkout of it, as
// the dialogs' review defaults it (shared/cloneDestination.ts): the
// source's own layout with this device's home swapped for the
// target's, or where the target keeps its repos. `parent` is the
// caller's pick, a path under this device's home read as the same path
// under the target's, the way the default is. The target's home and
// projects are its own answers, over the grant the send needs anyway.
export async function cloneIntoOn(
  deviceId: string,
  project: Project,
  parent: string | undefined,
): Promise<SyncCloneInto> {
  const here = homedir();
  if (parent !== undefined) {
    return cloneIntoOf(tildify(parent, here), project.path);
  }
  const [info, projects] = await Promise.all([
    peerClient(runtimeContract, deviceId).info(),
    peerClient(projectsContract, deviceId).list(),
  ]);
  return cloneIntoOf(
    moveCloneParent({
      sourcePath: project.path,
      sourceHome: here,
      destinationHome: info.homedir,
      destinationProjects: projects,
    }),
    project.path,
  );
}

// Every worktree of the repo that could move, on the peers that hold
// it, beside the peers that hold it and did not answer. A
// blocked-for-commands peer still lists (reads are ungated), so a bring
// can say which device to unblock. A worktree with no branch of its own
// can't be moved (sync:sendWorktree refuses one the same way). A
// primary is listed: a mirror can take it, and a bring says why not.
export async function worktreesOn(standings: ControlDevice[]): Promise<{
  worktrees: ControlPeerWorktree[];
  unanswered: ControlDevice[];
}> {
  const unanswered: ControlDevice[] = [];
  const lists = await Promise.all(
    standings.map(async (device): Promise<ControlPeerWorktree[]> => {
      const { projectId } = device;
      if (projectId === undefined) return [];
      try {
        const answer = await within(
          peerWorktreesApiFor(device.deviceId).list({ projectId }),
          () => null,
        );
        if (answer === null) throw new Error("no answer");
        return answer
          .filter(
            (worktree) => !worktree.detached && isRealBranch(worktree.branch),
          )
          .map((worktree) => ({
            device: { deviceId: device.deviceId, name: device.name },
            projectId,
            worktree,
          }));
      } catch {
        unanswered.push(device);
        return [];
      }
    }),
  );
  return { worktrees: lists.flat(), unanswered };
}

// Which devices have a direct session up, each with whether it runs
// this device's commands.
export const directPeers = () => requireImpl().directPeers();
