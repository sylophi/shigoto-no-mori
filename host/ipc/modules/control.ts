// The CLI's cross-device verbs, served on the control wire
// (shared/ipc/modules/control.ts says why they live in the app). Each
// op resolves what the caller named the way the dialogs do, then hands
// the run to the SAME orchestrator a dialog calls (sync:sendWorktree,
// sync:pullWorktree, mirror:start, mirror:startTo, mirror:stop) with
// the caller's context, so progress streams back down the control wire
// and a closed socket aborts like a closed window. Nothing here moves
// a byte or touches git itself.
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
  mirrorCopyIsRemote,
  type MirrorSession,
  isMirrorCopyStayed,
  isMirrorStopUnconfirmed,
} from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import type { ClientTransport, HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { hostsProjects } from "@shared/account/enroll";
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
  type Worktree,
  WorktreeSchema,
} from "@shared/schemas";
import { Schema } from "effect";
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

// The Electron layer injects the account and the peer reach at boot
// (main/ipc/handlers.ts), like the other peer seams (peerSync.ts): the
// device registry rides the stored credential and the peer transport
// is the shared cached direct session, both main's.
type ControlImpl = {
  // The account's device registry. Empty when signed out.
  listDevices: () => Promise<DeviceInfo[]>;
  thisDeviceId: () => string;
  // The devices a direct session is established to, the only ones a
  // call can reach.
  connectedDeviceIds: () => Promise<readonly string[]>;
  // For the two asks outside the peer sync seam (peerSync.ts): what a
  // peer hosts and whether it accepts commands.
  peerTransportFor: (deviceId: string) => ClientTransport;
};

let impl: ControlImpl | null = null;

export function setControlImpl(next: ControlImpl): void {
  impl = next;
}

function requireImpl(): ControlImpl {
  if (impl === null) {
    throw new Error("control op requested before setControlImpl ran");
  }
  return impl;
}

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
    throw new ControlError({
      code: "signed-out",
      message:
        "This device's access to the account was removed. Sign in again from the app.",
    });
  }
  const hereId = thisDeviceId();
  const here = devices.find((device) => device.deviceId === hereId);
  if (here === undefined) {
    throw new ControlError({
      code: "signed-out",
      message:
        "This device isn't signed in to an account, so it has no other devices to reach. Sign in from the app first.",
    });
  }
  return {
    here: { deviceId: hereId, name: nameOf(here) },
    // A browser on the account is a device too, but hosts no forest.
    peers: devices.filter(
      (device) => device.deviceId !== hereId && hostsProjects(device.platform),
    ),
  };
}

const GRANTED = { granted: true };

// Where each peer stands for one repo: the dialogs' three blocks in
// the dialogs' order (renderer/components/shared/deviceTargets.ts),
// read fresh off the peers themselves. A read skips the grant ask,
// since reads are ungated.
async function standingsOf(
  devices: DeviceInfo[],
  identity: string | null,
  { grant }: { grant: boolean },
): Promise<ControlDevice[]> {
  const connected = new Set(await requireImpl().connectedDeviceIds());
  return Promise.all(
    devices.map((device) => standingOf(device, identity, connected, grant)),
  );
}

async function standingOf(
  device: DeviceInfo,
  identity: string | null,
  connected: ReadonlySet<string>,
  grant: boolean,
): Promise<ControlDevice> {
  const base = {
    deviceId: device.deviceId,
    name: nameOf(device),
    platform: device.platform,
  };
  const offline = { ...base, block: "offline" as const };
  if (!connected.has(device.deviceId)) return offline;
  const transport = requireImpl().peerTransportFor(device.deviceId);
  try {
    const asked = await within(
      Promise.all([
        buildClient(projectsContract, transport).list(),
        grant
          ? buildClient(remoteAccessContract, transport).commandAccess()
          : GRANTED,
      ]),
      () => null,
    );
    if (asked === null) return offline;
    const [projects, access] = asked;
    // A null identity never matches: it means this device couldn't
    // tell what repo this is, not "the same unknown repo".
    const held =
      identity === null
        ? undefined
        : projects.find(
            (project) =>
              project.identity === identity && project.pathExists !== false,
          );
    if (held === undefined) return { ...base, block: "no-project" };
    return {
      ...base,
      projectId: held.id,
      ...(access.granted ? {} : { block: "no-grant" as const }),
    };
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
    throw new ControlError({
      code: "no-device",
      message:
        "This account has no other device. Sign in to the app on another machine first.",
    });
  }
  let asked = peers;
  if (query !== undefined) {
    asked = matchDevices(peers, query);
    if (asked.length === 0) {
      throw new ControlError({
        code: "no-device",
        message: `No device is named "${query}". The account's other devices: ${listed(peers.map((device) => ({ name: nameOf(device) })))}.`,
      });
    }
    if (asked.length > 1) {
      throw new ControlError({
        code: "ambiguous-device",
        message: `"${query}" matches several devices: ${listed(asked.map((device) => ({ name: nameOf(device) })))}. Name one in full, or pass its id.`,
      });
    }
  }
  const identity = await repoIdentityOf(project);
  return { identity, standings: await standingsOf(asked, identity, { grant }) };
}

// The one device a transfer goes to or comes from.
async function pickDevice(
  project: Project,
  query: string | undefined,
): Promise<{ identity: string | null; target: ControlDevice }> {
  const { identity, standings } = await candidates(project, query, {
    grant: true,
  });
  const ready = standings.filter((device) => device.block === undefined);
  if (ready.length === 1) return { identity, target: ready[0] };
  if (ready.length > 1) {
    throw new ControlError({
      code: "ambiguous-device",
      message: `Several devices could take part: ${listed(ready)}. Name one.`,
    });
  }
  const why = standings
    .map(
      (device) => `"${device.name}" ${BLOCK_REASON[device.block ?? "offline"]}`,
    )
    .join(", ");
  throw new ControlError({
    code: "device-blocked",
    message:
      query === undefined
        ? `No other device can take part: ${why}.`
        : `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
  });
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

function mirrorView(session: MirrorSession, devices: Named[]): ControlMirror {
  return {
    session: session.session,
    device: {
      deviceId: session.deviceId,
      name:
        devices.find((device) => device.deviceId === session.deviceId)?.name ??
        session.deviceId,
    },
    localProjectId: session.localProjectId,
    localWorktreeId: session.localWorktreeId,
    localRoot: session.localRoot,
    remoteRoot: session.remoteRoot,
    copySide: mirrorCopyIsRemote(session) ? "remote" : "local",
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
async function peerNames(): Promise<Named[]> {
  const devices = await registryOrEmpty();
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

// The mirror one of this device's worktrees is part of, original or
// copy.
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
        const connected = await requireImpl().connectedDeviceIds();
        return {
          thisDevice: here,
          devices: peers.map((device) => ({
            deviceId: device.deviceId,
            name: nameOf(device),
            platform: device.platform,
            ...(connected.includes(device.deviceId)
              ? {}
              : { block: "offline" as const }),
          })),
        };
      }
      const identity = await repoIdentityOf(findProjectOrThrow(projectId));
      return {
        thisDevice: here,
        devices: await standingsOf(peers, identity, { grant: true }),
      };
    },

    peerWorktrees: async ({ projectId, device }) => {
      const { standings } = await candidates(
        findProjectOrThrow(projectId),
        device,
        { grant: false },
      );
      const unreachable = standings.filter(
        (standing) => standing.block === "offline",
      );
      // A device asked for by name and not there is a refusal, not an
      // empty list.
      if (device !== undefined && unreachable.length > 0) {
        throw new ControlError({
          code: "device-blocked",
          message: `"${unreachable[0].name}" ${BLOCK_REASON.offline}.`,
        });
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
        const running = await mirrorOf(ctx, input);
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
          syncHandlers.teardownSent(
            {
              targetDeviceId: target.deviceId,
              projectId: project.id,
              worktreeId: worktree.id,
            },
            ctx,
          ),
      });
      return { ...sent, device, copySide: "remote", source };
    },

    bring: async (input, ctx): Promise<ControlTransferResult> => {
      const project = findProjectOrThrow(input.projectId);
      const { identity, standings } = await candidates(project, input.device, {
        grant: true,
      });
      const { worktrees, unanswered } = await worktreesOn(standings);
      const found = pickWorktree(worktrees, input.worktree, [
        ...standings.filter((device) => device.block === "offline"),
        ...unanswered,
      ]);
      const standing = standings.find(
        (device) => device.deviceId === found.device.deviceId,
      );
      if (standing?.block !== undefined) {
        throw new ControlError({
          code: "device-blocked",
          message: `"${found.device.name}" ${BLOCK_REASON[standing.block]}.`,
        });
      }
      if (identity === null) {
        // Unreachable past pickWorktree (a null identity matches no
        // peer, so none listed a worktree), kept so the payload below
        // is typed honestly.
        throw new ControlError({
          code: "device-blocked",
          message:
            "This repo has no shared identity, so it can't be matched with another device's.",
        });
      }
      const choice = await choiceFor(identity, input, () =>
        peerSyncApiFor(found.device.deviceId).ignoredPaths({
          projectId: found.projectId,
          worktreeId: found.worktree.id,
        }),
      );
      const payload = {
        sourceDeviceId: found.device.deviceId,
        sourceProjectId: found.projectId,
        sourceWorktreeId: found.worktree.id,
        sourceIdentity: identity,
        branch: found.worktree.branch,
        worktreeName: pullWorktreeName(found.worktree),
        ...choice,
      };
      if (input.mirror === true) {
        const { sessions } = await mirrorHandlers.list(undefined, ctx);
        const running = sessions.find(
          (candidate) =>
            candidate.deviceId === found.device.deviceId &&
            candidate.projectId === found.projectId &&
            candidate.worktreeId === found.worktree.id,
        );
        if (running !== undefined) {
          return alreadyMirrored(ctx, running, undefined);
        }
        const { session, ...pulled } = await mirrorHandlers.start(payload, ctx);
        return { ...pulled, device: found.device, copySide: "local", session };
      }
      const pulled = await syncHandlers.pullWorktree(payload, ctx);
      const sourceRef = {
        sourceDeviceId: found.device.deviceId,
        sourceProjectId: found.projectId,
        sourceWorktreeId: found.worktree.id,
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

    mirrors: async (_input, ctx) => {
      const [{ daemon, sessions }, names] = await Promise.all([
        mirrorHandlers.list(undefined, ctx),
        peerNames(),
      ]);
      return {
        daemon,
        mirrors: sessions.map((session) => mirrorView(session, names)),
      };
    },

    mirrorStop: async ({ force, ...target }, ctx) => {
      const session = await mirrorOf(ctx, target);
      if (session === undefined) {
        throw new ControlError({
          code: "no-mirror",
          message: "That worktree isn't mirrored.",
        });
      }
      // The names are only for the answer, so they are read beside the
      // stop and not after it.
      const names = peerNames();
      let copyStayed: string | undefined;
      try {
        await mirrorHandlers.stop({ session: session.session, force }, ctx);
      } catch (error) {
        if (isMirrorStopUnconfirmed(error)) {
          throw new ControlError({
            code: "stop-unconfirmed",
            message: errorMessageOf(error),
          });
        }
        // Thrown with the session already gone, so the stop is the
        // answer and the copy that stayed is a caveat on it.
        if (!isMirrorCopyStayed(error)) throw error;
        copyStayed = errorMessageOf(error);
      }
      return {
        mirror: mirrorView(session, await names),
        ...(copyStayed === undefined ? {} : { copyStayed }),
      };
    },
  };

// A second "mirror it" for a worktree already mirrored is a question
// about the first, not a new copy: the transfer would only be refused
// over the branch or the folder the copy holds. Answered with the
// running session and its copy, whichever side that is on.
async function alreadyMirrored(
  ctx: HandlerContext,
  session: MirrorSession,
  device: string | undefined,
): Promise<ControlTransferResult> {
  const registry = await registryOrEmpty();
  const view = mirrorView(
    session,
    registry.map((entry) => ({
      deviceId: entry.deviceId,
      name: nameOf(entry),
    })),
  );
  if (device !== undefined) {
    // The same reading of a name a fresh start would make.
    const named = matchDevices(registry, device);
    if (named.length !== 1 || named[0].deviceId !== session.deviceId) {
      throw new ControlError({
        code: "device-blocked",
        message: `This worktree is already mirrored with "${view.device.name}", and a worktree holds one mirror. Stop that one first (sm worktrees unmirror).`,
      });
    }
  }
  const copy = mirrorCopyIsRemote(session)
    ? await peerWorktreeOrUndefined(
        session.deviceId,
        session.projectId,
        session.worktreeId,
      )
    : (
        await worktreesHandlers.list({ projectId: session.localProjectId }, ctx)
      ).find((worktree) => worktree.id === session.localWorktreeId);
  if (copy === undefined) {
    // Not a reason to start a second session beside the first.
    throw new ControlError({
      code: "no-worktree",
      message: `This worktree is mirrored with "${view.device.name}", but its copy is gone. Stop the mirror (sm worktrees unmirror -f) before starting another.`,
    });
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

const decodeWorktrees = Schema.decodeUnknownSync(Schema.Array(WorktreeSchema));

// Every worktree of the repo that could move, on the peers that hold
// it, beside the peers that hold it and did not answer. A
// blocked-for-commands peer still lists (reads are ungated), so a bring
// can say which device to unblock. A worktree with no branch of its own
// can't be moved (sync:sendWorktree refuses one the same way), and the
// list is re-parsed because its branch goes on into git here.
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
        return decodeWorktrees(answer)
          .filter(
            (worktree) =>
              !worktree.isPrimary &&
              !worktree.detached &&
              isRealBranch(worktree.branch),
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
    throw new ControlError({
      code: "ambiguous-worktree",
      message: `"${query}" is on several devices: ${listed(found.map((entry) => entry.device))}. Name one with --from.`,
    });
  }
  const known = all
    .map((entry) => `${entry.worktree.name} (${entry.device.name})`)
    .join(", ");
  throw new ControlError({
    code: "no-worktree",
    message: [
      `No worktree "${query}" on another device.`,
      known === "" ? "" : ` There: ${known}.`,
      unreachable.length === 0
        ? ""
        : ` Not reached, so not looked at: ${listed(unreachable)}.`,
    ].join(""),
  });
}
