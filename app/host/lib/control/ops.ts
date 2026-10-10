// The terminal's cross-device verbs, served on the loopback
// (packages/contracts/src/modules/control.ts says why they live in the
// app; host/ipc/modules/control.ts serves them). Each op resolves what
// the caller named the way the dialogs do, then hands the run to the
// SAME orchestrator a dialog calls (sync:sendWorktree,
// sync:pullWorktree, mirror:startTo, mirror:startFrom, mirror:stop)
// with the caller's context, so progress streams back down the control
// wire and a closed socket aborts like a closed window. A mirror runs
// on the device holding the original, so `mirror --from` is the
// mirror:startFrom the "Mirror here" dialog runs: it invites the
// mirror, asks the peer to run its mirror:startTo into this device,
// and relays the peer's progress. Nothing here moves a byte or touches
// git itself.
import { only } from "@shigomori/contracts/util/only";
import {
  type ControlDevice,
  ControlError,
  type ControlMirror,
  type ControlTransferResult,
  type controlContract,
} from "@shigomori/contracts/modules/control";
import {
  isMirrorCopyStayed,
  isMirrorStopUnconfirmed,
} from "@shigomori/contracts/modules/mirror";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { pullWorktreeName } from "@shigomori/contracts/git/branches";
import {
  type IgnoreSelection,
  type MirrorIgnoreChoice,
  needsIgnoredList,
  resolveIgnores,
  selectionOfPreset,
  setupDefaultFor,
} from "@shigomori/contracts/leaveOutRule";
import { type Project } from "@shigomori/contracts/schemas";
import {
  parseLeaveOutPreset,
  sharedSettingKeys,
  sharedStringSetting,
} from "@shigomori/contracts/sharedSettings";
import {
  peerSyncApiFor,
  peerWorktreeOrUndefined,
  peerWorktreesApiFor,
  thisDeviceId,
} from "@host/ipc/peerSync";
import {
  findProjectAndWorktreeOrThrow,
  findProjectOrThrow,
} from "@host/lib/projects";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import {
  mirrorList,
  startMirrorFrom,
  startMirrorTo,
  stopMirror as stopMirrorSession,
} from "@host/mirror/sessions";
import { syncHandlers } from "@host/ipc/modules/sync";
import { worktreesHandlers } from "@host/ipc/modules/worktrees";
import {
  BLOCK_REASON,
  chooseTarget,
  matchDevices,
  mirrorView,
  type Named,
  nameOf,
  namesOf,
  peerMirrorView,
  pickWorktree,
  type Running,
} from "./plan";
import {
  candidates,
  cloneIntoOn,
  type DirectPeer,
  directPeers,
  mirrorOf,
  peerMirrorOf,
  peerMirrors,
  registryOrEmpty,
  repoIdentityOf,
  roster,
  standingsOf,
  worktreesOn,
} from "./peers";

type Ops = Handlers<typeof controlContract, HandlerContext>;

// A transfer, which the loopback serves as a stream of its progress
// (the sync:pullProgress pushes `ctx` notifies) and then its answer.
type TransferOp<K extends "send" | "bring"> = (
  input: Parameters<ViewHandlers<typeof controlContract, never>[K]>[0],
  ctx: HandlerContext,
) => Promise<ControlTransferResult>;

// The one device a send goes to, among the candidates (plan.ts
// chooseTarget).
async function pickDevice(
  project: Project,
  query: string | undefined,
): Promise<{ identity: string | null; target: ControlDevice }> {
  const { identity, standings } = await candidates(project, query, {
    grant: true,
  });
  return { identity, target: chooseTarget(standings, query) };
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
  running: Running,
  device: string | undefined,
): Promise<ControlTransferResult> {
  const registry = await registryOrEmpty();
  const names = namesOf(registry);
  const { session } = running;
  const ranHere = running.deviceId === thisDeviceId();
  const view = ranHere
    ? mirrorView(session, names)
    : peerMirrorView(running, names);
  if (device !== undefined) {
    // The same reading of a name a fresh start would make.
    const named = only(matchDevices(registry, device));
    if (named === undefined || named.deviceId !== view.device.deviceId) {
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
    : (await worktreesHandlers.list({ projectId: session.projectId })).find(
        (worktree) => worktree.id === session.worktreeId,
      );
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

// A device's block when no project was asked about.
function blockOf(peer: DirectPeer | undefined): Pick<ControlDevice, "block"> {
  if (peer === undefined) return { block: "offline" };
  return peer.sharesData ? {} : { block: "not-sharing" };
}

export const devices: Ops["devices"] = async ({ projectId }) => {
  const { here, peers } = await roster();
  if (projectId === undefined) {
    const direct = await directPeers();
    return {
      thisDevice: here,
      devices: peers.map((device) => ({
        deviceId: device.deviceId,
        name: nameOf(device),
        platform: device.platform,
        ...blockOf(direct[device.deviceId]),
      })),
    };
  }
  const identity = await repoIdentityOf(await findProjectOrThrow(projectId));
  return {
    thisDevice: here,
    devices: await standingsOf(peers, identity, { grant: true }),
  };
};

export const peerWorktrees: Ops["peerWorktrees"] = async ({
  projectId,
  device,
}) => {
  const { standings } = await candidates(
    await findProjectOrThrow(projectId),
    device,
    { grant: false },
  );
  const unreachable = standings.filter(
    (standing) => standing.block === "offline",
  );
  // A device asked for by name and not there, or not sharing, is a
  // refusal, not an empty list. Unnamed, one that isn't sharing lists
  // nothing.
  const blocked = standings.find(
    (standing) =>
      standing.block === "offline" || standing.block === "not-sharing",
  );
  if (device !== undefined && blocked?.block !== undefined) {
    throw new ControlError(
      "device-blocked",
      `"${blocked.name}" ${BLOCK_REASON[blocked.block]}.`,
    );
  }
  const { worktrees, unanswered } = await worktreesOn(standings);
  return {
    worktrees,
    unreachable: [...unreachable, ...unanswered].map(
      (standing) => standing.name,
    ),
  };
};

export const send: TransferOp<"send"> = async (
  input,
  ctx,
): Promise<ControlTransferResult> => {
  const { project, worktree } = await findProjectAndWorktreeOrThrow(
    input.projectId,
    input.worktreeId,
  );
  const mirror = input.mirror === true;
  if (mirror) {
    // Part of a mirror already: its original (a session run here)
    // or its copy (a session a peer runs).
    const own = mirrorOf(input);
    const running =
      own === undefined
        ? await peerMirrorOf(input, registryOrEmpty())
        : { deviceId: thisDeviceId(), session: own };
    if (running !== undefined) {
      return alreadyMirrored(running, input.device);
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
    const { session, ...sent } = await startMirrorTo(payload, ctx);
    return { ...sent, device, copySide: "remote", session };
  }
  const sent = await syncHandlers.sendWorktree(payload, ctx);
  const source = await settleSource(input.source ?? "keep", {
    shelve: async () =>
      worktreesHandlers.setShelved({
        projectId: project.id,
        worktreeId: worktree.id,
        shelved: true,
      }),
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
};

export const bring: TransferOp<"bring"> = async (
  input,
  ctx,
): Promise<ControlTransferResult> => {
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
  if (input.device !== undefined && standings[0]?.block === "not-sharing") {
    throw new ControlError(
      "device-blocked",
      `"${standings[0].name}" ${BLOCK_REASON["not-sharing"]}.`,
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
    const { sessions } = mirrorList();
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
        : { deviceId: thisDeviceId(), session: own };
    if (running !== undefined) {
      return alreadyMirrored(running, undefined);
    }
    const { session, ...pulled } = await startMirrorFrom(
      {
        sourceDeviceId: found.device.deviceId,
        sourceProjectId: found.projectId,
        sourceWorktreeId: found.worktree.id,
        sourceIdentity: identity,
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
};

// The mirrors this device is part of: the ones it runs, and the
// ones peers run against its worktrees, each seen from this side.
// One registry read serves the peer scan and the names.
export const mirrors: Ops["mirrors"] = async () => {
  const registry = registryOrEmpty();
  const [{ daemon, sessions }, afar, names] = await Promise.all([
    mirrorList(),
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
};

// Stops the mirror the worktree is part of, whichever device runs
// it: a session this device runs is stopped here, one a peer runs
// against the worktree is stopped through that peer (mirror:stop
// is gated on the runner's command-access switch). The names are only
// for the answer, so the registry is read beside the stop and not
// after it, once for the peer scan too.
export const mirrorStop: Ops["mirrorStop"] = async (
  { force, ...target },
  ctx,
) => {
  const registry = registryOrEmpty();
  const answer = async (
    mirror: (names: Named[]) => ControlMirror,
    copyStayed: string | undefined,
  ) => ({
    mirror: mirror(namesOf(await registry)),
    ...(copyStayed === undefined ? {} : { copyStayed }),
  });
  const own = mirrorOf(target);
  if (own !== undefined) {
    const copyStayed = await stopMirror(() =>
      stopMirrorSession(own.session, force === true),
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
};
