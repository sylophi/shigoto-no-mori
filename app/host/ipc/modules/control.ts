// The CLI's cross-device verbs, served on the control wire
// (shared/ipc/modules/control.ts says why they live in the app). Each
// op resolves what the caller named the way the dialogs do, then hands
// the run to the SAME orchestrator a dialog calls (sync:sendWorktree,
// sync:pullWorktree, mirror:startTo, mirror:stop) with the caller's
// context, so progress streams back down the control wire and a closed
// socket aborts like a closed window. A mirror runs on the device
// holding the original, so `mirror --from` asks the peer to run its
// mirror:startTo into this device, and relays the peer's progress.
// Nothing here moves a byte or touches git itself.
import { homedir } from "node:os";
import { buildClient } from "@shared/ipc/buildClient";
import {
  type ControlDevice,
  ControlError,
  type ControlMirror,
  type ControlPeerWorktree,
  type ControlTransferResult,
  controlContract,
} from "@shared/ipc/modules/control";
import {
  type MirrorSession,
  isMirrorCopyStayed,
  isMirrorStopUnconfirmed,
  mirrorContract,
  type MirrorStartToPayload,
  MirrorStartToResultSchema,
} from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { runtimeContract } from "@shared/ipc/modules/runtime";
import {
  type SyncCloneInto,
  SyncPullProgressSchema,
  syncContract,
} from "@shared/ipc/modules/sync";
import { cloneIntoOf, moveCloneParent } from "@shared/cloneDestination";
import { tildify } from "@shared/projectPaths";
import type { ClientTransport, HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { hostsProjects } from "@shared/account/platform";
import { isHubRefusal } from "@shared/account/service";
import { errorMessageOf } from "@shared/errors";
import { pullWorktreeName } from "@shared/git/branches";
import type { DeviceInfo } from "@shared/hub/protocol";
import {
  type IgnoreSelection,
  type MirrorIgnoreChoice,
  needsIgnoredList,
  resolveIgnores,
  selectionOfPreset,
  setupDefaultFor,
} from "@shared/leaveOutRule";
import { PROBE_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import {
  isRealBranch,
  type Project,
  ProjectSchema,
  RuntimeInfoSchema,
  type Worktree,
  WorktreeSchema,
} from "@shared/schemas";
import {
  parseLeaveOutPreset,
  sharedSettingKeys,
  sharedStringSetting,
} from "@shared/sharedSettings";
import {
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
} from "@host/ipc/peerSync";
import { getRepoIdentity } from "@host/lib/git/repoIdentity";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import { mirrorHandlers } from "./mirror";
import { syncHandlers } from "./sync";
import { worktreesHandlers } from "./worktrees";
import { implSlot } from "@host/lib/util/implSlot";

// The Electron layer injects the account and the peer reach at boot
// (main/ipc/handlers.ts), like the other peer seams (peerSync.ts): the
// device registry rides the stored credential and the peer transport
// is the shared cached direct session, both main's.
type ControlImpl = {
  // The account's device registry. Empty when signed out.
  listDevices: () => Promise<DeviceInfo[]>;
  thisDeviceId: () => string;
  // This device's own command-access switch: whether the account's
  // other devices may run commands here.
  acceptsCommands: () => boolean;
  // The devices a direct session is established to (the only ones a
  // call can reach), each with whether it runs this device's commands:
  // the hub status snapshot's peerAcceptsCommands, the same reading
  // the app's windows show.
  directPeers: () => Promise<Readonly<Record<string, boolean>>>;
  // For the asks outside the peer sync seam (peerSync.ts): what a peer
  // hosts, and its mirrors.
  peerTransportFor: (deviceId: string) => ClientTransport;
};

const { set: setControlImpl, get: requireImpl } = implSlot<ControlImpl>(
  "control op requested before setControlImpl ran",
);
export { setControlImpl };

type Named = { deviceId: string; name: string };

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

// A device with no name of its own still has to be told apart.
const nameOf = (device: DeviceInfo): string =>
  device.name.trim() === "" ? device.deviceId : device.name;

async function roster(): Promise<{ here: Named; peers: DeviceInfo[] }> {
  const { listDevices, thisDeviceId } = requireImpl();
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

// The registry's other hosts. A browser on the account is a device
// too, but hosts no forest.
function peersOf(devices: DeviceInfo[], hereId: string): DeviceInfo[] {
  return devices.filter(
    (device) => device.deviceId !== hereId && hostsProjects(device.platform),
  );
}

// Where each peer stands for one repo: the dialogs' three blocks in
// the dialogs' order (renderer/components/shared/deviceTargets.ts),
// the checkout read fresh off the peer and the command access off the
// status snapshot. A read leaves the access out, since reads are
// ungated.
async function standingsOf(
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
  const transport = requireImpl().peerTransportFor(device.deviceId);
  try {
    const projects = await within(
      buildClient(projectsContract, transport).list(),
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

const BLOCK_REASON: Record<NonNullable<ControlDevice["block"]>, string> = {
  offline: "not connected",
  "no-project": "has no checkout of this repo",
  "no-grant": "doesn't accept commands (turn it on from its Devices page)",
};

function matchDevices(peers: DeviceInfo[], query: string): DeviceInfo[] {
  const wanted = query.trim().toLowerCase();
  const byId = peers.filter((device) => device.deviceId === query);
  if (byId.length > 0) return byId;
  const exact = peers.filter(
    (device) => nameOf(device).toLowerCase() === wanted,
  );
  if (exact.length > 0) return exact;
  return peers.filter((device) =>
    nameOf(device).toLowerCase().startsWith(wanted),
  );
}

const listed = (devices: { name: string }[]): string =>
  devices.map((device) => `"${device.name}"`).join(", ");

// A checkout git can't read (its folder moved away) has no identity
// to match on, the same as one with no shared identity.
const repoIdentityOf = (project: Project): Promise<string | null> =>
  getRepoIdentity(project.path).catch(() => null);

// The peers a transfer of this repo could run against: the named one,
// or every one. Each comes back with its standing, blocked or not,
// beside the identity they were matched on.
async function candidates(
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

// The one device a send goes to. A device with no checkout of the repo
// takes it too (it clones the repo first, as the dialogs offer), but
// only when no device holding the repo could: left unnamed, a send
// lands where the repo already is.
async function pickDevice(
  project: Project,
  query: string | undefined,
): Promise<{ identity: string | null; target: ControlDevice }> {
  const { identity, standings } = await candidates(project, query, {
    grant: true,
  });
  const holding = standings.filter((device) => device.block === undefined);
  const ready =
    holding.length > 0
      ? holding
      : standings.filter((device) => device.block === "no-project");
  if (ready.length === 1) return { identity, target: ready[0] };
  if (ready.length > 1) {
    throw new ControlError(
      "ambiguous-device",
      `Several devices could take part: ${listed(ready)}. Name one.`,
    );
  }
  const why = standings
    .map(
      (device) => `"${device.name}" ${BLOCK_REASON[device.block ?? "offline"]}`,
    )
    .join(", ");
  throw new ControlError(
    "device-blocked",
    query === undefined
      ? `No other device can take part: ${why}.`
      : `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  );
}

function presetSelection(identity: string | null): IgnoreSelection {
  return selectionOfPreset(
    parseLeaveOutPreset(
      identity === null
        ? undefined
        : sharedStringSetting(
            sharedSettingsCopy.read(),
            sharedSettingKeys.leaveOutPreset(identity),
          ),
    ),
  );
}

const NO_EXCEPTIONS: ReadonlySet<string> = new Set();

// The rule and the setup switch, as the review step would hand them
// to the mutation: the project's preset unless the caller named a
// plain rule, resolved over the SOURCE worktree's ignored list.
async function choiceFor(
  identity: string | null,
  options: { leaveOut?: "nothing" | "gitignored"; setup?: boolean },
  ignoredOfSource: () => Promise<Parameters<typeof resolveIgnores>[1]>,
): Promise<MirrorIgnoreChoice & { runSetup: boolean }> {
  const selection: IgnoreSelection =
    options.leaveOut === undefined
      ? presetSelection(identity)
      : {
          base: options.leaveOut === "nothing" ? "everything" : "gitignored",
          leftOut: NO_EXCEPTIONS,
          brought: NO_EXCEPTIONS,
        };
  // Without the list the gitignored rule would resolve to no patterns
  // and leave nothing out, so a failed read fails the op (the dialog
  // holds Start for the same reason).
  const ignored = needsIgnoredList(selection)
    ? await ignoredOfSource()
    : undefined;
  return {
    ...resolveIgnores(selection, ignored),
    runSetup: options.setup ?? setupDefaultFor(selection),
  };
}

const nameFor = (deviceId: string, devices: Named[]): string =>
  devices.find((device) => device.deviceId === deviceId)?.name ?? deviceId;

function mirrorView(session: MirrorSession, devices: Named[]): ControlMirror {
  return {
    session: session.session,
    device: {
      deviceId: session.deviceId,
      name: nameFor(session.deviceId, devices),
    },
    localProjectId: session.localProjectId,
    localWorktreeId: session.localWorktreeId,
    localRoot: session.localRoot,
    remoteRoot: session.remoteRoot,
    // The session runs on the original's device, so the copy is the
    // runner's peer.
    copySide: "remote",
    paused: session.paused,
    status: session.status,
    statusText: session.statusText,
    ...(session.git === undefined
      ? {}
      : { git: session.git.status, gitDetail: session.git.detail }),
    conflicts: session.conflicts.length,
  };
}

// Names for the mirror views. A signed-out or unreachable registry
// leaves the ids standing in, since a list must still answer.
function namesOf(devices: DeviceInfo[]): Named[] {
  return devices.map((device) => ({
    deviceId: device.deviceId,
    name: nameOf(device),
  }));
}

async function registryOrEmpty(): Promise<DeviceInfo[]> {
  try {
    return await within(requireImpl().listDevices(), () => []);
  } catch {
    return [];
  }
}

// A session and the device running it.
type Running = { deviceId: string; session: MirrorSession };

// A session a peer runs against one of this device's worktrees, with
// the peer and the client to drive it through.
type PeerMirror = Running & { api: ReturnType<typeof peerMirrorApi> };

function peerMirrorApi(deviceId: string) {
  return buildClient(mirrorContract, requireImpl().peerTransportFor(deviceId));
}

// The sessions peers run against this device's worktrees, found by
// asking each connected peer of the registry for its list (a read,
// ungated). A peer that does not answer in a probe's time, or an
// older one without the call, holds nothing this device can drive
// anyway. Signed out, the registry is empty, so the answer is empty
// rather than a refusal: the device's own sessions were already
// looked at.
async function peerMirrors(registry: DeviceInfo[]): Promise<PeerMirror[]> {
  const hereId = requireImpl().thisDeviceId();
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

async function peerMirrorOf(
  target: { projectId: string; worktreeId: string },
  registry: Promise<DeviceInfo[]>,
): Promise<PeerMirror | undefined> {
  return (await peerMirrors(await registry)).find(
    ({ session }) =>
      session.projectId === target.projectId &&
      session.worktreeId === target.worktreeId,
  );
}

// A peer's session as this device sees it: the runner's view with the
// two sides swapped, the peer being the other device, and the copy a
// stop removes the one here.
function peerMirrorView(
  { deviceId, session }: Running,
  devices: Named[],
): ControlMirror {
  return {
    ...mirrorView(session, devices),
    device: { deviceId, name: nameFor(deviceId, devices) },
    localProjectId: session.projectId,
    localWorktreeId: session.worktreeId,
    localRoot: session.remoteRoot,
    remoteRoot: session.localRoot,
    copySide: "local",
  };
}

// The mirror one of this device's worktrees is the original of, among
// the sessions this device runs (a copy here is a peer's session).
async function mirrorOf(
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

// What became of the source, in the finish step's terms. A fate that
// could not be carried out is an answer, never a throw: the transfer
// already stands.
async function settleSource(
  fate: "keep" | "shelve" | "teardown",
  run: {
    shelve: () => Promise<unknown>;
    teardown: () => Promise<{ sourceRemoved: boolean; sourceError?: string }>;
  },
): Promise<NonNullable<ControlTransferResult["source"]>> {
  if (fate === "keep") return { fate, done: true };
  try {
    if (fate === "shelve") {
      await run.shelve();
      return { fate, done: true };
    }
    const result = await run.teardown();
    return result.sourceRemoved
      ? { fate, done: true }
      : {
          fate,
          done: false,
          error: result.sourceError ?? "its teardown was refused.",
        };
  } catch (error) {
    return { fate, done: false, error: errorMessageOf(error) };
  }
}

export const controlHandlers: Handlers<typeof controlContract, HandlerContext> =
  {
    devices: async ({ projectId }) => {
      const { here, peers } = await roster();
      if (projectId === undefined) {
        const direct = await requireImpl().directPeers();
        return {
          thisDevice: here,
          devices: peers.map((device) => ({
            deviceId: device.deviceId,
            name: nameOf(device),
            platform: device.platform,
            ...(direct[device.deviceId] !== undefined
              ? {}
              : { block: "offline" as const }),
          })),
        };
      }
      const identity = await repoIdentityOf(
        await findProjectOrThrow(projectId),
      );
      return {
        thisDevice: here,
        devices: await standingsOf(peers, identity, { grant: true }),
      };
    },

    peerWorktrees: async ({ projectId, device }) => {
      const { standings } = await candidates(
        await findProjectOrThrow(projectId),
        device,
        { grant: false },
      );
      const unreachable = standings.filter(
        (standing) => standing.block === "offline",
      );
      // A device asked for by name and not there is a refusal, not an
      // empty list.
      if (device !== undefined && unreachable.length > 0) {
        throw new ControlError(
          "device-blocked",
          `"${unreachable[0].name}" ${BLOCK_REASON.offline}.`,
        );
      }
      const { worktrees, unanswered } = await worktreesOn(standings);
      return {
        worktrees,
        unreachable: [...unreachable, ...unanswered].map(
          (standing) => standing.name,
        ),
      };
    },

    send: async (input, ctx): Promise<ControlTransferResult> => {
      const { project, worktree } = await findProjectAndWorktreeOrThrow(
        input.projectId,
        input.worktreeId,
      );
      const mirror = input.mirror === true;
      if (mirror) {
        // Part of a mirror already: its original (a session run here)
        // or its copy (a session a peer runs).
        const own = await mirrorOf(ctx, input);
        const running =
          own === undefined
            ? await peerMirrorOf(input, registryOrEmpty())
            : { deviceId: requireImpl().thisDeviceId(), session: own };
        if (running !== undefined) {
          return alreadyMirrored(ctx, running, input.device);
        }
      }
      const { identity, target } = await pickDevice(project, input.device);
      const choice = await choiceFor(identity, input, async () =>
        syncHandlers.ignoredPaths(
          { projectId: project.id, worktreeId: worktree.id },
          ctx,
        ),
      );
      const device = { deviceId: target.deviceId, name: target.name };
      const payload = {
        targetDeviceId: target.deviceId,
        projectId: project.id,
        worktreeId: worktree.id,
        ...choice,
        ...(target.projectId === undefined
          ? {
              cloneInto: await cloneIntoOn(
                target.deviceId,
                project,
                input.cloneInto,
              ),
            }
          : {}),
      };
      if (mirror) {
        const { session, ...sent } = await mirrorHandlers.startTo(payload, ctx);
        return { ...sent, device, copySide: "remote", session };
      }
      const sent = await syncHandlers.sendWorktree(payload, ctx);
      const source = await settleSource(input.source ?? "keep", {
        shelve: async () =>
          worktreesHandlers.setShelved(
            { projectId: project.id, worktreeId: worktree.id, shelved: true },
            ctx,
          ),
        teardown: async () =>
          syncHandlers.teardownSource(
            {
              direction: "send",
              deviceId: target.deviceId,
              projectId: project.id,
              worktreeId: worktree.id,
            },
            ctx,
          ),
      });
      return { ...sent, device, copySide: "remote", source };
    },

    bring: async (input, ctx): Promise<ControlTransferResult> => {
      const project = await findProjectOrThrow(input.projectId);
      const { identity, standings } = await candidates(project, input.device, {
        grant: true,
      });
      // A device named that holds no checkout has no worktree to bring
      // (a send to it would clone the repo there, a bring cannot).
      if (input.device !== undefined && standings[0]?.block === "no-project") {
        throw new ControlError(
          "device-blocked",
          `"${standings[0].name}" ${BLOCK_REASON["no-project"]}, so it has nothing to bring.`,
        );
      }
      const { worktrees, unanswered } = await worktreesOn(standings);
      const found = pickWorktree(worktrees, input.worktree, [
        ...standings.filter((device) => device.block === "offline"),
        ...unanswered,
      ]);
      const standing = standings.find(
        (device) => device.deviceId === found.device.deviceId,
      );
      if (standing?.block !== undefined) {
        throw new ControlError(
          "device-blocked",
          `"${found.device.name}" ${BLOCK_REASON[standing.block]}.`,
        );
      }
      // The primary is the project itself: a mirror can take it (as a
      // worktree on mirror/<branch> here), a bring cannot.
      if (found.worktree.isPrimary && input.mirror !== true) {
        throw new ControlError(
          "no-worktree",
          `${found.worktree.name} is "${found.device.name}"'s primary checkout, which can be mirrored but not brought (sm worktrees mirror --from).`,
        );
      }
      if (identity === null) {
        // Unreachable past pickWorktree (a null identity matches no
        // peer, so none listed a worktree), kept so the payload below
        // is typed honestly.
        throw new ControlError(
          "device-blocked",
          "This repo has no shared identity, so it can't be matched with another device's.",
        );
      }
      const choice = await choiceFor(identity, input, () =>
        peerSyncApiFor(found.device.deviceId).ignoredPaths({
          projectId: found.projectId,
          worktreeId: found.worktree.id,
        }),
      );
      if (input.mirror === true) {
        // Mirrored already: the peer's worktree is the copy of a
        // session run here, or the original of one the peer runs.
        const { sessions } = await mirrorHandlers.list(undefined, ctx);
        const own = sessions.find(
          (candidate) =>
            candidate.deviceId === found.device.deviceId &&
            candidate.projectId === found.projectId &&
            candidate.worktreeId === found.worktree.id,
        );
        const running =
          own === undefined
            ? (await peerMirrors(await registryOrEmpty())).find(
                ({ deviceId, session }) =>
                  deviceId === found.device.deviceId &&
                  session.localProjectId === found.projectId &&
                  session.localWorktreeId === found.worktree.id,
              )
            : { deviceId: requireImpl().thisDeviceId(), session: own };
        if (running !== undefined) {
          return alreadyMirrored(ctx, running, undefined);
        }
        const { session, ...pulled } = await mirrorFromPeer(
          found.device,
          {
            projectId: found.projectId,
            worktreeId: found.worktree.id,
            ...choice,
          },
          ctx,
        );
        return { ...pulled, device: found.device, copySide: "local", session };
      }
      const pulled = await syncHandlers.pullWorktree(
        {
          sourceDeviceId: found.device.deviceId,
          sourceProjectId: found.projectId,
          sourceWorktreeId: found.worktree.id,
          sourceIdentity: identity,
          branch: found.worktree.branch,
          worktreeName: pullWorktreeName(found.worktree),
          ...choice,
        },
        ctx,
      );
      const sourceRef = {
        direction: "pull" as const,
        deviceId: found.device.deviceId,
        projectId: found.projectId,
        worktreeId: found.worktree.id,
      };
      const source = await settleSource(input.source ?? "keep", {
        shelve: () =>
          peerWorktreesApiFor(found.device.deviceId).setShelved({
            projectId: found.projectId,
            worktreeId: found.worktree.id,
            shelved: true,
          }),
        teardown: async () => syncHandlers.teardownSource(sourceRef, ctx),
      });
      return { ...pulled, device: found.device, copySide: "local", source };
    },

    // The mirrors this device is part of: the ones it runs, and the
    // ones peers run against its worktrees, each seen from this side.
    // One registry read serves the peer scan and the names.
    mirrors: async (_input, ctx) => {
      const registry = registryOrEmpty();
      const [{ daemon, sessions }, afar, names] = await Promise.all([
        mirrorHandlers.list(undefined, ctx),
        registry.then(peerMirrors),
        registry.then(namesOf),
      ]);
      return {
        daemon,
        mirrors: [
          ...sessions.map((session) => mirrorView(session, names)),
          ...afar.map((mirror) => peerMirrorView(mirror, names)),
        ],
      };
    },

    // Stops the mirror the worktree is part of, whichever device runs
    // it: a session this device runs is stopped here, one a peer runs
    // against the worktree is stopped through that peer (mirror:stop
    // is gated on the runner's command-access switch). The names are only
    // for the answer, so the registry is read beside the stop and not
    // after it, once for the peer scan too.
    mirrorStop: async ({ force, ...target }, ctx) => {
      const registry = registryOrEmpty();
      const answer = async (
        mirror: (names: Named[]) => ControlMirror,
        copyStayed: string | undefined,
      ) => ({
        mirror: mirror(namesOf(await registry)),
        ...(copyStayed === undefined ? {} : { copyStayed }),
      });
      const own = await mirrorOf(ctx, target);
      if (own !== undefined) {
        const copyStayed = await stopMirror(() =>
          mirrorHandlers.stop({ session: own.session, force }, ctx),
        );
        return answer((names) => mirrorView(own, names), copyStayed);
      }
      const afar = await peerMirrorOf(target, registry);
      if (afar === undefined) {
        throw new ControlError("no-mirror", "That worktree isn't mirrored.");
      }
      let copyStayed = await stopMirror(() =>
        afar.api.stop({ session: afar.session.session, force }),
      );
      // The copy the peer could not remove is the one HERE: the peer
      // removes it through this device's command-access switch, which
      // need not be on for a peer this device only asked something of.
      // The session is gone either way, so this device's own forced
      // delete finishes what the runner's stop would have.
      if (copyStayed !== undefined) {
        const removed = await worktreesHandlers.delete(
          {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
            force: true,
          },
          ctx,
        );
        if (removed.ok) copyStayed = undefined;
      }
      return answer((names) => peerMirrorView(afar, names), copyStayed);
    },
  };

// A stop's two refusals told apart, wherever it ran: the confirmation
// rule is the CLI's typed error, and a copy that stayed comes back as
// the caveat (thrown with the session already gone, so the stop is
// the answer).
async function stopMirror(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (isMirrorStopUnconfirmed(error)) {
      throw new ControlError("stop-unconfirmed", errorMessageOf(error));
    }
    if (!isMirrorCopyStayed(error)) throw error;
    return errorMessageOf(error);
  }
}

// A second "mirror it" for a worktree already mirrored is a question
// about the first, not a new copy: the transfer would only be refused
// over the branch or the folder the copy holds. Answered with the
// running session and its copy, the session's remote side: the peer's
// worktree for a session run here, this device's for one a peer runs.
async function alreadyMirrored(
  ctx: HandlerContext,
  running: Running,
  device: string | undefined,
): Promise<ControlTransferResult> {
  const registry = await registryOrEmpty();
  const names = namesOf(registry);
  const { session } = running;
  const ranHere = running.deviceId === requireImpl().thisDeviceId();
  const view = ranHere
    ? mirrorView(session, names)
    : peerMirrorView(running, names);
  if (device !== undefined) {
    // The same reading of a name a fresh start would make.
    const named = matchDevices(registry, device);
    if (named.length !== 1 || named[0].deviceId !== view.device.deviceId) {
      throw new ControlError(
        "device-blocked",
        `This worktree is already mirrored with "${view.device.name}", and a worktree holds one mirror. Stop that one first (sm worktrees unmirror).`,
      );
    }
  }
  const copy = ranHere
    ? await peerWorktreeOrUndefined(
        session.deviceId,
        session.projectId,
        session.worktreeId,
      )
    : (
        await worktreesHandlers.list({ projectId: session.projectId }, ctx)
      ).find((worktree) => worktree.id === session.worktreeId);
  if (copy === undefined) {
    // Not a reason to start a second session beside the first.
    throw new ControlError(
      "no-worktree",
      `This worktree is mirrored with "${view.device.name}", but its copy is gone. Stop the mirror (sm worktrees unmirror -f) before starting another.`,
    );
  }
  return {
    worktree: copy,
    captured: false,
    dirtyApplied: false,
    device: view.device,
    copySide: view.copySide,
    session: session.session,
    alreadyMirrored: true,
  };
}

// A mirror of a peer's worktree into this device. The session runs on
// the device holding the original, so it is the peer's mirror:startTo,
// asked over its command access, that sends the copy here, and that
// send lands through THIS device's command access: a device that
// refuses commands is told so up front, before the peer is asked. The
// peer's progress comes back as its pushes, keyed by its worktree, and
// is relayed to the caller.
async function mirrorFromPeer(
  device: Named,
  input: Omit<MirrorStartToPayload, "targetDeviceId">,
  ctx: HandlerContext,
) {
  const { acceptsCommands, peerTransportFor, thisDeviceId } = requireImpl();
  if (!acceptsCommands()) {
    throw new ControlError(
      "device-blocked",
      `A mirror runs on the device holding the original, so "${device.name}" sends the copy here, and this device doesn't accept commands. Turn command access on for this device (its Devices page in the app), then try again.`,
    );
  }
  const transport = peerTransportFor(device.deviceId);
  const notify = ctx.notifier(syncContract, "pullProgress");
  const stopRelay = buildClient(syncContract, transport).pullProgress(
    (frame) => {
      const parsed = SyncPullProgressSchema.safeParse(frame);
      if (parsed.success && parsed.data.sourceWorktreeId === input.worktreeId) {
        notify(parsed.data);
      }
    },
  );
  try {
    return MirrorStartToResultSchema.parse(
      await buildClient(mirrorContract, transport).startTo({
        ...input,
        targetDeviceId: thisDeviceId(),
      }),
    );
  } finally {
    stopRelay();
  }
}

// Where a send clones the repo on a device with no checkout of it, as
// the dialogs' review defaults it (shared/cloneDestination.ts): the
// source's own layout with this device's home swapped for the
// target's, or where the target keeps its repos. `parent` is the
// caller's pick, a path under this device's home read as the same path
// under the target's, the way the default is. The target's home and
// projects are its own answers, over the grant the send needs anyway.
async function cloneIntoOn(
  deviceId: string,
  project: Project,
  parent: string | undefined,
): Promise<SyncCloneInto> {
  const here = homedir();
  if (parent !== undefined) {
    return cloneIntoOf(tildify(parent, here), project.path);
  }
  const transport = requireImpl().peerTransportFor(deviceId);
  const [info, projects] = await Promise.all([
    buildClient(runtimeContract, transport).info(),
    buildClient(projectsContract, transport).list(),
  ]);
  return cloneIntoOf(
    moveCloneParent({
      sourcePath: project.path,
      sourceHome: here,
      destinationHome: RuntimeInfoSchema.parse(info).homedir,
      destinationProjects: ProjectSchema.array().parse(projects),
    }),
    project.path,
  );
}

// Every worktree of the repo that could move, on the peers that hold
// it, beside the peers that hold it and did not answer. A
// blocked-for-commands peer still lists (reads are ungated), so a bring
// can say which device to unblock. A worktree with no branch of its own
// can't be moved (sync:sendWorktree refuses one the same way), and the
// list is re-parsed because its branch goes on into git here. A
// primary is listed: a mirror can take it, and a bring says why not.
async function worktreesOn(standings: ControlDevice[]): Promise<{
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
        return WorktreeSchema.array()
          .parse(answer)
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

const matchesWorktree = (worktree: Worktree, query: string): boolean =>
  worktree.id === query || worktree.name === query || worktree.branch === query;

function pickWorktree(
  all: ControlPeerWorktree[],
  query: string,
  unreachable: ControlDevice[],
): ControlPeerWorktree {
  const found = all.filter((entry) => matchesWorktree(entry.worktree, query));
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new ControlError(
      "ambiguous-worktree",
      `"${query}" is on several devices: ${listed(found.map((entry) => entry.device))}. Name one with --from.`,
    );
  }
  const known = all
    .map((entry) => `${entry.worktree.name} (${entry.device.name})`)
    .join(", ");
  throw new ControlError(
    "no-worktree",
    [
      `No worktree "${query}" on another device.`,
      known === "" ? "" : ` There: ${known}.`,
      unreachable.length === 0
        ? ""
        : ` Not reached, so not looked at: ${listed(unreachable)}.`,
    ].join(""),
  );
}
