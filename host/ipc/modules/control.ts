// The CLI's cross-device verbs, served on the control wire
// (shared/ipc/modules/control.ts says why they live in the app). Each
// op resolves what the caller named the way the dialogs do, then hands
// the run to the SAME orchestrator a dialog calls (sync:sendWorktree,
// sync:pullWorktree, mirror:start, mirror:startTo, mirror:stop) with
// the caller's context, so progress streams back down the control wire
// and a closed socket aborts like a closed window. Nothing here moves
// a byte or touches git itself.
//
// Every op is an Effect run under the control connection's signal, and
// the orchestrators it hands to are the Effects themselves (not their
// wire handlers), so the CLI going away interrupts the one fiber doing
// the work, down to the transfer's next chunk.
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
} from "@shared/ipc/modules/mirror";
import { projectsContract } from "@shared/ipc/modules/projects";
import { remoteAccessContract } from "@shared/ipc/modules/remoteAccess";
import type { ClientTransport, HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { hostsProjects } from "@shared/account/enroll";
import { isHubRefusal } from "@shared/account/service";
import {
  errorMessageOf,
  isMirrorCopyStayed,
  isMirrorStopUnconfirmed,
} from "@shared/errors";
import { pullWorktreeName } from "@shared/git/branches";
import {
  type DeviceId,
  type DeviceInfo,
  isDeviceId,
} from "@shared/hub/protocol";
import {
  type IgnoreSelection,
  type MirrorIgnoreChoice,
  needsIgnoredList,
  resolveIgnores,
  selectionOfPreset,
  setupDefaultFor,
} from "@shared/leaveOutRule";
import { PROBE_TIMEOUT_MS } from "@shared/ipc/socket/frames";
import { isRealBranch, type Project, type Worktree } from "@shared/schemas";
import { Context, Effect, Fiber, Option } from "effect";
import {
  parseLeaveOutPreset,
  sharedSettingKeys,
  sharedStringSetting,
} from "@shared/sharedSettings";
import {
  type PeerApis,
  peerApis,
  peerWorktree,
  peerWorktreeList,
} from "@host/ipc/peerSync";
import { getRepoIdentityEffect } from "@host/lib/git/repoIdentity";
import { findProject, findProjectAndWorktree } from "@host/lib/projects";
import { sharedSettingsCopy } from "@host/lib/sharedSettings/store";
import { hostAttempt, hostHandler, requireService } from "@host/runtime";
import { mirrorList, startMirror, startMirrorTo, stopMirror } from "./mirror";
import {
  ignoredPathsOf,
  runPullWorktree,
  sendWorktree,
  teardownSent,
  teardownSource,
} from "./sync";
import { listWorktrees, setShelvedWorktree } from "./worktrees";

// The Electron layer provides the account and the peer reach
// (main/electron/hostImpls.ts), like the other peer seams
// (peerSync.ts): the device registry rides the stored credential and
// the peer transport is the shared cached direct session, both main's.
type ControlImpl = {
  // The account's device registry. Empty when signed out.
  listDevices: () => Promise<readonly DeviceInfo[]>;
  thisDeviceId: () => string;
  // The devices a direct session is established to, the only ones a
  // call can reach.
  connectedDeviceIds: () => Promise<readonly string[]>;
  // For the two asks outside the peer sync seam (peerSync.ts): what a
  // peer hosts and whether it accepts commands.
  peerTransportFor: (deviceId: string) => ClientTransport;
};

export class ControlReach extends Context.Service<ControlReach, ControlImpl>()(
  "sm/host/ControlReach",
) {}

const controlReach = requireService(
  ControlReach,
  "control op requested before the host runtime provided ControlReach",
);

type Named = { deviceId: DeviceId; name: string };

// A registry entry whose id is a well-formed device id: the only kind a
// peer call can reach (invokePeer and the hub relay refuse any other),
// and the only kind the hub enrolls.
type Peer = DeviceInfo & { readonly deviceId: DeviceId };
const isPeer = (device: DeviceInfo): device is Peer =>
  isDeviceId(device.deviceId);

// An ask that only informs an answer gets a probe's patience: a peer
// whose session is up but whose app is wedged would otherwise hold a
// listing until the heartbeat gives up on it, and the registry is a
// hub round trip with no clock of its own. The ask that runs late is
// interrupted (its answer is never waited for).
const withinProbe = <A, E, R>(asked: Effect.Effect<A, E, R>) =>
  Effect.timeoutOption(asked, PROBE_TIMEOUT_MS);

// A device with no name of its own still has to be told apart.
const nameOf = (device: DeviceInfo): string =>
  device.name.trim() === "" ? device.deviceId : device.name;

const roster = Effect.gen(function* () {
  const { listDevices, thisDeviceId } = yield* controlReach;
  const devices = (yield* hostAttempt(() => listDevices()).pipe(
    // A credential the hub no longer honors (the device was removed
    // from the account while the app held it) is the signed-out case
    // with a reason, not a raw hub error for the CLI to print.
    Effect.mapError((error) =>
      isHubRefusal(error)
        ? new ControlError({
            code: "signed-out",
            message:
              "This device's access to the account was removed. Sign in again from the app.",
          })
        : error,
    ),
  )).filter(isPeer);
  const hereId = thisDeviceId();
  const here = devices.find((device) => device.deviceId === hereId);
  if (here === undefined) {
    return yield* new ControlError({
      code: "signed-out",
      message:
        "This device isn't signed in to an account, so it has no other devices to reach. Sign in from the app first.",
    });
  }
  return {
    here: { deviceId: here.deviceId, name: nameOf(here) } satisfies Named,
    // A browser on the account is a device too, but hosts no forest.
    peers: devices.filter(
      (device) => device.deviceId !== hereId && hostsProjects(device.platform),
    ),
  };
});

const GRANTED = { granted: true };

// Where each peer stands for one repo: the dialogs' three blocks in
// the dialogs' order (renderer/components/shared/deviceTargets.ts),
// read fresh off the peers themselves. A read skips the grant ask,
// since reads are ungated.
const standingsOf = (
  devices: readonly Peer[],
  identity: string | null,
  { grant }: { grant: boolean },
) =>
  Effect.gen(function* () {
    const reach = yield* controlReach;
    const connected = new Set(
      yield* hostAttempt(() => reach.connectedDeviceIds()),
    );
    return yield* Effect.all(
      devices.map((device) =>
        standingOf(reach, device, identity, connected, grant),
      ),
      { concurrency: "unbounded" },
    );
  });

const standingOf = (
  reach: ControlImpl,
  device: Peer,
  identity: string | null,
  connected: ReadonlySet<string>,
  grant: boolean,
): Effect.Effect<ControlDevice> => {
  const base = {
    deviceId: device.deviceId,
    name: nameOf(device),
    platform: device.platform,
  };
  const offline: ControlDevice = { ...base, block: "offline" };
  if (!connected.has(device.deviceId)) return Effect.succeed(offline);
  return Effect.gen(function* () {
    const transport = yield* hostAttempt(() =>
      reach.peerTransportFor(device.deviceId),
    );
    const asked = yield* withinProbe(
      Effect.all(
        [
          hostAttempt(() => buildClient(projectsContract, transport).list()),
          grant
            ? hostAttempt(() =>
                buildClient(remoteAccessContract, transport).commandAccess(),
              )
            : Effect.succeed(GRANTED),
        ],
        { concurrency: "unbounded" },
      ),
    );
    if (Option.isNone(asked)) return offline;
    const [projects, access] = asked.value;
    // A null identity never matches: it means this device couldn't
    // tell what repo this is, not "the same unknown repo".
    const held =
      identity === null
        ? undefined
        : projects.find(
            (project) =>
              project.identity === identity && project.pathExists !== false,
          );
    if (held === undefined) return { ...base, block: "no-project" as const };
    return {
      ...base,
      projectId: held.id,
      ...(access.granted ? {} : { block: "no-grant" as const }),
    };
  }).pipe(
    // The session dropped between the roster read and the ask.
    Effect.orElseSucceed(() => offline),
  );
};

const BLOCK_REASON: Record<NonNullable<ControlDevice["block"]>, string> = {
  offline: "not connected",
  "no-project": "has no checkout of this repo",
  "no-grant": "doesn't accept commands (turn it on from its Devices page)",
};

function matchDevices(peers: readonly Peer[], query: string): Peer[] {
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
const repoIdentityOf = (project: Project) =>
  getRepoIdentityEffect(project.path).pipe(Effect.orElseSucceed(() => null));

// The peers a transfer of this repo could run against: the named one,
// or every one. Each comes back with its standing, blocked or not,
// beside the identity they were matched on.
const candidates = (
  project: Project,
  query: string | undefined,
  { grant }: { grant: boolean },
) =>
  Effect.gen(function* () {
    const { peers } = yield* roster;
    if (peers.length === 0) {
      return yield* new ControlError({
        code: "no-device",
        message:
          "This account has no other device. Sign in to the app on another machine first.",
      });
    }
    let asked = peers;
    if (query !== undefined) {
      asked = matchDevices(peers, query);
      if (asked.length === 0) {
        return yield* new ControlError({
          code: "no-device",
          message: `No device is named "${query}". The account's other devices: ${listed(peers.map((device) => ({ name: nameOf(device) })))}.`,
        });
      }
      if (asked.length > 1) {
        return yield* new ControlError({
          code: "ambiguous-device",
          message: `"${query}" matches several devices: ${listed(asked.map((device) => ({ name: nameOf(device) })))}. Name one in full, or pass its id.`,
        });
      }
    }
    const identity = yield* repoIdentityOf(project);
    return {
      identity,
      standings: yield* standingsOf(asked, identity, { grant }),
    };
  });

// The one device a transfer goes to or comes from.
const pickDevice = (project: Project, query: string | undefined) =>
  Effect.gen(function* () {
    const { identity, standings } = yield* candidates(project, query, {
      grant: true,
    });
    const ready = standings.filter((device) => device.block === undefined);
    if (ready.length === 1) return { identity, target: ready[0] };
    if (ready.length > 1) {
      return yield* new ControlError({
        code: "ambiguous-device",
        message: `Several devices could take part: ${listed(ready)}. Name one.`,
      });
    }
    const why = standings
      .map(
        (device) =>
          `"${device.name}" ${BLOCK_REASON[device.block ?? "offline"]}`,
      )
      .join(", ");
    return yield* new ControlError({
      code: "device-blocked",
      message:
        query === undefined
          ? `No other device can take part: ${why}.`
          : `${why.charAt(0).toUpperCase()}${why.slice(1)}.`,
    });
  });

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
const choiceFor = <E, R>(
  identity: string | null,
  options: { leaveOut?: "nothing" | "gitignored"; setup?: boolean },
  ignoredOfSource: Effect.Effect<Parameters<typeof resolveIgnores>[1], E, R>,
) =>
  Effect.gen(function* () {
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
      ? yield* ignoredOfSource
      : undefined;
    const choice: MirrorIgnoreChoice & { runSetup: boolean } = {
      ...resolveIgnores(selection, ignored),
      runSetup: options.setup ?? setupDefaultFor(selection),
    };
    return choice;
  });

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

// The account's registry for an answer that only names devices: a
// signed-out or unreachable one (or one past a probe's patience)
// leaves the ids standing in, since a list must still answer.
const registryOrEmpty = Effect.gen(function* () {
  const { listDevices } = yield* controlReach;
  const none: readonly DeviceInfo[] = [];
  const devices: readonly DeviceInfo[] = yield* hostAttempt(() =>
    listDevices(),
  ).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT_MS,
      orElse: () => Effect.succeed(none),
    }),
    Effect.orElseSucceed(() => none),
  );
  return devices.filter(isPeer);
});

// Names for the mirror views.
const peerNames = Effect.map(registryOrEmpty, (devices) =>
  devices.map(
    (device): Named => ({ deviceId: device.deviceId, name: nameOf(device) }),
  ),
);

// The mirror one of this device's worktrees is part of, original or
// copy.
const mirrorOf = (target: { projectId: string; worktreeId: string }) =>
  Effect.map(mirrorList, ({ sessions }) =>
    sessions.find(
      (candidate) =>
        candidate.localProjectId === target.projectId &&
        candidate.localWorktreeId === target.worktreeId,
    ),
  );

// What became of the source, in the finish step's terms. A fate that
// could not be carried out is an answer, never a throw: the transfer
// already stands. A caller that leaves still interrupts it.
type SourceOutcome = NonNullable<ControlTransferResult["source"]>;

const settleSource = <R1, R2>(
  fate: "keep" | "shelve" | "teardown",
  run: {
    shelve: Effect.Effect<unknown, unknown, R1>;
    teardown: Effect.Effect<
      { sourceRemoved: boolean; sourceError?: string },
      unknown,
      R2
    >;
  },
): Effect.Effect<SourceOutcome, never, R1 | R2> => {
  if (fate === "keep") return Effect.succeed({ fate, done: true });
  const settled: Effect.Effect<SourceOutcome, unknown, R1 | R2> =
    fate === "shelve"
      ? Effect.as(run.shelve, { fate, done: true })
      : Effect.map(
          run.teardown,
          (result): SourceOutcome =>
            result.sourceRemoved
              ? { fate, done: true }
              : {
                  fate,
                  done: false,
                  error: result.sourceError ?? "its teardown was refused.",
                },
        );
  return settled.pipe(
    Effect.catch((error) =>
      Effect.succeed({ fate, done: false, error: errorMessageOf(error) }),
    ),
  );
};

export const controlHandlers: Handlers<typeof controlContract, HandlerContext> =
  {
    devices: hostHandler(({ projectId }) =>
      Effect.gen(function* () {
        const { here, peers } = yield* roster;
        if (projectId === undefined) {
          const reach = yield* controlReach;
          const connected = yield* hostAttempt(() =>
            reach.connectedDeviceIds(),
          );
          return {
            thisDevice: here,
            devices: peers.map(
              (device): ControlDevice => ({
                deviceId: device.deviceId,
                name: nameOf(device),
                platform: device.platform,
                ...(connected.includes(device.deviceId)
                  ? {}
                  : { block: "offline" as const }),
              }),
            ),
          };
        }
        const project = yield* findProject(projectId);
        const identity = yield* repoIdentityOf(project);
        return {
          thisDevice: here,
          devices: yield* standingsOf(peers, identity, { grant: true }),
        };
      }),
    ),

    peerWorktrees: hostHandler(({ projectId, device }) =>
      Effect.gen(function* () {
        const project = yield* findProject(projectId);
        const { standings } = yield* candidates(project, device, {
          grant: false,
        });
        const unreachable = standings.filter(
          (standing) => standing.block === "offline",
        );
        // A device asked for by name and not there is a refusal, not an
        // empty list.
        if (device !== undefined && unreachable.length > 0) {
          return yield* new ControlError({
            code: "device-blocked",
            message: `"${unreachable[0].name}" ${BLOCK_REASON.offline}.`,
          });
        }
        const { worktrees, unanswered } = yield* worktreesOn(standings);
        return {
          worktrees,
          unreachable: [...unreachable, ...unanswered].map(
            (standing) => standing.name,
          ),
        };
      }),
    ),

    send: hostHandler((input, ctx: HandlerContext) =>
      Effect.gen(function* () {
        const { project, worktree } = yield* findProjectAndWorktree(
          input.projectId,
          input.worktreeId,
        );
        const mirror = input.mirror === true;
        if (mirror) {
          const running = yield* mirrorOf(input);
          if (running !== undefined) {
            return yield* alreadyMirrored(running, input.device);
          }
        }
        const { identity, target } = yield* pickDevice(project, input.device);
        const choice = yield* choiceFor(
          identity,
          input,
          ignoredPathsOf({ projectId: project.id, worktreeId: worktree.id }),
        );
        const device = { deviceId: target.deviceId, name: target.name };
        const payload = {
          targetDeviceId: target.deviceId,
          projectId: project.id,
          worktreeId: worktree.id,
          ...choice,
        };
        if (mirror) {
          const { session, ...sent } = yield* startMirrorTo(payload, ctx);
          const result: ControlTransferResult = {
            ...sent,
            device,
            copySide: "remote",
            session,
          };
          return result;
        }
        const sent = yield* sendWorktree(payload, ctx);
        const source = yield* settleSource(input.source ?? "keep", {
          shelve: setShelvedWorktree({
            projectId: project.id,
            worktreeId: worktree.id,
            shelved: true,
          }),
          teardown: teardownSent(
            {
              targetDeviceId: target.deviceId,
              projectId: project.id,
              worktreeId: worktree.id,
            },
            ctx,
          ),
        });
        const result: ControlTransferResult = {
          ...sent,
          device,
          copySide: "remote",
          source,
        };
        return result;
      }),
    ),

    bring: hostHandler((input, ctx: HandlerContext) =>
      Effect.gen(function* () {
        const project = yield* findProject(input.projectId);
        const { identity, standings } = yield* candidates(
          project,
          input.device,
          { grant: true },
        );
        const { worktrees, unanswered } = yield* worktreesOn(standings);
        const found = yield* pickWorktree(worktrees, input.worktree, [
          ...standings.filter((device) => device.block === "offline"),
          ...unanswered,
        ]);
        const standing = standings.find(
          (device) => device.deviceId === found.device.deviceId,
        );
        if (standing?.block !== undefined) {
          return yield* new ControlError({
            code: "device-blocked",
            message: `"${found.device.name}" ${BLOCK_REASON[standing.block]}.`,
          });
        }
        if (identity === null) {
          // Unreachable past pickWorktree (a null identity matches no
          // peer, so none listed a worktree), kept so the payload below
          // is typed honestly.
          return yield* new ControlError({
            code: "device-blocked",
            message:
              "This repo has no shared identity, so it can't be matched with another device's.",
          });
        }
        const apis = yield* peerApis;
        const choice = yield* choiceFor(
          identity,
          input,
          hostAttempt(() =>
            apis.syncApiFor(found.device.deviceId).ignoredPaths({
              projectId: found.projectId,
              worktreeId: found.worktree.id,
            }),
          ),
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
          const { sessions } = yield* mirrorList;
          const running = sessions.find(
            (candidate) =>
              candidate.deviceId === found.device.deviceId &&
              candidate.projectId === found.projectId &&
              candidate.worktreeId === found.worktree.id,
          );
          if (running !== undefined) {
            return yield* alreadyMirrored(running, undefined);
          }
          const { session, ...pulled } = yield* startMirror(payload, ctx);
          const result: ControlTransferResult = {
            ...pulled,
            device: found.device,
            copySide: "local",
            session,
          };
          return result;
        }
        const pulled = yield* runPullWorktree(payload, ctx);
        const sourceRef = {
          sourceDeviceId: found.device.deviceId,
          sourceProjectId: found.projectId,
          sourceWorktreeId: found.worktree.id,
        };
        const source = yield* settleSource(input.source ?? "keep", {
          shelve: hostAttempt(() =>
            apis.worktreesApiFor(found.device.deviceId).setShelved({
              projectId: found.projectId,
              worktreeId: found.worktree.id,
              shelved: true,
            }),
          ),
          teardown: teardownSource(sourceRef),
        });
        const result: ControlTransferResult = {
          ...pulled,
          device: found.device,
          copySide: "local",
          source,
        };
        return result;
      }),
    ),

    mirrors: hostHandler(() =>
      Effect.gen(function* () {
        const [{ daemon, sessions }, names] = yield* Effect.all(
          [mirrorList, peerNames],
          { concurrency: "unbounded" },
        );
        return {
          daemon,
          mirrors: sessions.map((session) => mirrorView(session, names)),
        };
      }),
    ),

    mirrorStop: hostHandler(({ force, ...target }, ctx: HandlerContext) =>
      Effect.gen(function* () {
        const session = yield* mirrorOf(target);
        if (session === undefined) {
          return yield* new ControlError({
            code: "no-mirror",
            message: "That worktree isn't mirrored.",
          });
        }
        // The names are only for the answer, so they are read beside
        // the stop and not after it.
        const names = yield* Effect.forkChild(peerNames);
        const copyStayed = yield* stopMirror(
          { session: session.session, force },
          ctx,
        ).pipe(
          Effect.as(undefined),
          Effect.catch((error) => {
            if (isMirrorStopUnconfirmed(error)) {
              return Effect.fail(
                new ControlError({
                  code: "stop-unconfirmed",
                  message: errorMessageOf(error),
                }),
              );
            }
            // Thrown with the session already gone, so the stop is the
            // answer and the copy that stayed is a caveat on it.
            return isMirrorCopyStayed(error)
              ? Effect.succeed(errorMessageOf(error))
              : Effect.fail(error);
          }),
        );
        return {
          mirror: mirrorView(session, yield* Fiber.join(names)),
          ...(copyStayed === undefined ? {} : { copyStayed }),
        };
      }),
    ),
  };

// A second "mirror it" for a worktree already mirrored is a question
// about the first, not a new copy: the transfer would only be refused
// over the branch or the folder the copy holds. Answered with the
// running session and its copy, whichever side that is on.
const alreadyMirrored = (session: MirrorSession, device: string | undefined) =>
  Effect.gen(function* () {
    const registry = yield* registryOrEmpty;
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
        return yield* new ControlError({
          code: "device-blocked",
          message: `This worktree is already mirrored with "${view.device.name}", and a worktree holds one mirror. Stop that one first (sm worktrees unmirror).`,
        });
      }
    }
    const copy = mirrorCopyIsRemote(session)
      ? yield* peerWorktree(
          session.deviceId,
          session.projectId,
          session.worktreeId,
        )
      : (yield* listWorktrees({ projectId: session.localProjectId })).find(
          (worktree) => worktree.id === session.localWorktreeId,
        );
    if (copy === undefined) {
      // Not a reason to start a second session beside the first.
      return yield* new ControlError({
        code: "no-worktree",
        message: `This worktree is mirrored with "${view.device.name}", but its copy is gone. Stop the mirror (sm worktrees unmirror -f) before starting another.`,
      });
    }
    // The session's peer is one this device dialed, so its id should
    // be well formed. A malformed one (an engine store edited by hand,
    // say) is the op's refusal, named, rather than a schema failure.
    const deviceId = view.device.deviceId;
    if (!isDeviceId(deviceId)) {
      return yield* new ControlError({
        code: "device-blocked",
        message: `This worktree is mirrored with a device whose id the mirror engine holds malformed ("${deviceId}"). Stop the mirror (sm worktrees unmirror -f) before starting another.`,
      });
    }
    const result: ControlTransferResult = {
      worktree: copy,
      captured: false,
      dirtyApplied: false,
      device: { deviceId, name: view.device.name },
      copySide: view.copySide,
      session: session.session,
      alreadyMirrored: true,
    };
    return result;
  });

// Every worktree of the repo that could move, on the peers that hold
// it, beside the peers that hold it and did not answer. A
// blocked-for-commands peer still lists (reads are ungated), so a bring
// can say which device to unblock. A worktree with no branch of its own
// can't be moved (sync:sendWorktree refuses one the same way), and the
// list is re-parsed because its branch goes on into git here.
const worktreesOn = (standings: ControlDevice[]) =>
  Effect.gen(function* () {
    const unanswered: ControlDevice[] = [];
    const lists = yield* Effect.all(
      standings.map(
        (device): Effect.Effect<ControlPeerWorktree[], never, PeerApis> => {
          const { projectId } = device;
          if (projectId === undefined) return Effect.succeed([]);
          return withinProbe(peerWorktreeList(device.deviceId, projectId)).pipe(
            Effect.flatMap((answer) =>
              Option.isNone(answer)
                ? Effect.fail(new Error("no answer"))
                : Effect.succeed(answer.value),
            ),
            Effect.map((worktrees) =>
              worktrees
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
                })),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                unanswered.push(device);
                return [];
              }),
            ),
          );
        },
      ),
      { concurrency: "unbounded" },
    );
    return { worktrees: lists.flat(), unanswered };
  });

const matchesWorktree = (worktree: Worktree, query: string): boolean =>
  worktree.id === query || worktree.name === query || worktree.branch === query;

const pickWorktree = (
  all: ControlPeerWorktree[],
  query: string,
  unreachable: ControlDevice[],
): Effect.Effect<ControlPeerWorktree, ControlError> => {
  const found = all.filter((entry) => matchesWorktree(entry.worktree, query));
  if (found.length === 1) return Effect.succeed(found[0]);
  if (found.length > 1) {
    return Effect.fail(
      new ControlError({
        code: "ambiguous-worktree",
        message: `"${query}" is on several devices: ${listed(found.map((entry) => entry.device))}. Name one with --from.`,
      }),
    );
  }
  const known = all
    .map((entry) => `${entry.worktree.name} (${entry.device.name})`)
    .join(", ");
  return Effect.fail(
    new ControlError({
      code: "no-worktree",
      message: [
        `No worktree "${query}" on another device.`,
        known === "" ? "" : ` There: ${known}.`,
        unreachable.length === 0
          ? ""
          : ` Not reached, so not looked at: ${listed(unreachable)}.`,
      ].join(""),
    }),
  );
};
