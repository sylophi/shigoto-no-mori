// The cross-device verbs. Two ideas, each with a direction:
//
//   send   [<name>] --to <device>       move a worktree to another device
//   bring  <worktree> --from <device>   move one of theirs here
//   mirror [<name>] --to <device>       keep a copy of it in step there
//   mirror <worktree> --from <device>   keep a copy of theirs in step here,
//                                       the mirror running on their device
//
// plus unmirror, mirrors, devices and a peer's worktrees. They run in the
// app (Control says why), through the same orchestrators its own dialogs
// use. The app resolves the names a person says (a device by its name, a
// peer's worktree by its folder name or branch, the one device that
// qualifies when none is named) and the folder a clone goes in, so a
// name is passed through as given. Answers are the documents `sm --json`
// prints, with the headline a person reads.
import {
  type ControlDevice,
  ControlLeaveOutSchema,
  type ControlMirror,
  type ControlPeerWorktree,
  ControlSourceFateSchema,
  type ControlTransferResult,
} from "@shigomori/contracts/modules/control";
import type { SyncPullProgress } from "@shigomori/contracts/modules/sync";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Control from "./Control.ts";
import type * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";
import type * as Registry from "./Registry.ts";
import type { RegisteredProject } from "./Registry.ts";
import * as Worktrees from "./Worktrees.ts";

// A transfer's flags as the command line gave them. An absent flag was
// not given, and an empty string was given blank.
export type TransferFlags = {
  readonly to?: string | undefined;
  readonly from?: string | undefined;
  readonly leaveOut?: string | undefined;
  readonly source?: string | undefined;
  readonly cloneInto?: string | undefined;
  readonly setup?: boolean | undefined;
  readonly noSetup?: boolean | undefined;
};

// A progress push: the event `sm --json` prints for it, and the step's
// line when it differs from the one before (a transfer pushes per chunk).
type ProgressDocument = Readonly<SyncPullProgress> & {
  readonly event: "progress";
};
export type Progress = {
  readonly document: ProgressDocument;
  readonly line: string | undefined;
};

export type OnProgress = (progress: Progress) => Effect.Effect<void>;

// The command line was what was wrong (the terminal exits 2).
export class TransferRefused extends Schema.TaggedError<TransferRefused>()(
  "TransferRefused",
  {
    reason: Schema.Literals([
      "blank-device",
      "send-direction",
      "bring-direction",
      "mirror-both",
      "no-worktree",
      "leave-out",
      "setup-both",
      "mirror-source",
      "source",
      "clone-into-bring",
      "clone-into-blank",
    ]),
    // The flag a blank device was given to.
    flag: Schema.String,
    binary: Schema.String,
  },
) {
  get usage(): boolean {
    return true;
  }

  override get message(): string {
    const bin = this.binary;
    switch (this.reason) {
      case "blank-device":
        return `--${this.flag} needs a device: its name, the start of its name, or its id (${bin} devices).`;
      case "send-direction":
        return `send goes --to a device. To move one here: ${bin} worktrees bring <worktree> --from <device>.`;
      case "bring-direction":
        return `bring comes --from a device. To move one there: ${bin} worktrees send [<name>] --to <device>.`;
      case "mirror-both":
        return "A mirror goes one way: --to a device, or --from one.";
      case "no-worktree":
        return `Which worktree? \`${bin} worktrees list --remote\` shows what your other devices hold.`;
      case "leave-out":
        return "--leave-out is nothing or gitignored.";
      case "setup-both":
        return "--setup and --no-setup can't both be given.";
      case "mirror-source":
        return "--source is for send and bring. A mirror keeps its original.";
      case "source":
        return "--source is keep, shelve, or teardown.";
      case "clone-into-bring":
        return "--clone-into is for send and mirror --to. A bring lands in this device's own checkout.";
      case "clone-into-blank":
        return "--clone-into needs a folder on the other device, the one its checkout of the repo goes in.";
    }
  }
}

// The app refused to stop a mirror that isn't in step. Its words, and
// what to do about it.
export class StopUnconfirmed extends Schema.TaggedError<StopUnconfirmed>()(
  "StopUnconfirmed",
  { said: Schema.String, binary: Schema.String },
) {
  override get message(): string {
    return `${this.said}\nStopping removes the copy, so make sure both sides hold the work (${this.binary} worktrees mirrors), or pass -f to stop anyway.`;
  }
  get documentCode(): string {
    return "stop-unconfirmed";
  }
}

// What a headline and the caveats read of a transfer's answer.
export type TransferResult = Pick<
  ControlTransferResult,
  "captured" | "dirtyApplied" | "files" | "source" | "alreadyMirrored"
> & {
  readonly worktree: { readonly name: string };
  readonly device: { readonly name: string };
  readonly cloned?: { readonly name: string; readonly path: string };
};

type NamedDevice = ControlPeerWorktree["device"];
type SourceOutcome = NonNullable<ControlTransferResult["source"]>;

type MirrorStop = {
  readonly mirror: ControlMirror;
  readonly copyStayed?: string;
};

type MirrorList = {
  readonly daemon: string;
  // Empty unless the engine is failing.
  readonly daemonFailure: string;
  readonly mirrors: ReadonlyArray<ControlMirror>;
};

type DeviceList = {
  readonly thisDevice: NamedDevice;
  readonly devices: ReadonlyArray<ControlDevice>;
};

type PeerWorktreeList = {
  readonly worktrees: ReadonlyArray<ControlPeerWorktree>;
  readonly unreachable: ReadonlyArray<string>;
};

// --- what the verbs answer ------------------------------------------------

// The answers as the contracts type them, which is what the app sends.
type Ok<T> = Readonly<T> & { readonly ok: true };
type WithCaveats<T> = Ok<T> & { readonly caveats: ReadonlyArray<string> };

// A finished send, bring or mirror: the document `sm --json` prints (the
// terminal exits 3 when it has caveats), the headline, and the answer
// the lines read.
export type Transferred = {
  readonly document: WithCaveats<ControlTransferResult>;
  readonly headline: string;
  readonly result: ControlTransferResult;
};

// A project's worktrees on the other devices: the document (list's
// shape, each saying whose it is), and the devices that weren't asked.
export type PeerWorktrees = {
  readonly document: ReadonlyArray<
    ControlPeerWorktree["worktree"] & { readonly device: NamedDevice }
  >;
  readonly project: RegisteredProject;
  readonly unreachable: ReadonlyArray<string>;
};

// A stopped mirror, and the worktree it was asked of. A copy that stayed
// is its caveat.
export type Unmirrored = {
  readonly document: WithCaveats<MirrorStop>;
  readonly worktree: Worktrees.WorktreeIdentity;
};

type ResolveError =
  | Worktrees.TargetError
  | Worktrees.UnknownWorktree
  | Registry.UnknownProject
  | Git.GitError;

type ReadError = Control.ControlError;

type TransferError = TransferRefused | ResolveError | ReadError;

type ProjectRef = Pick<Worktrees.Target, "project" | "projectId">;

export class Transfer extends Context.Service<
  Transfer,
  {
    // `sm worktrees send`: one of this device's worktrees to another.
    readonly send: (
      here: Worktrees.Here,
      target: Worktrees.Target,
      flags: TransferFlags,
      onProgress: OnProgress,
    ) => Effect.Effect<Transferred, TransferError>;
    // `sm worktrees bring`: the peer's worktree `target.ref` names, here.
    readonly bring: (
      here: Worktrees.Here,
      target: Worktrees.Target,
      flags: TransferFlags,
      onProgress: OnProgress,
    ) => Effect.Effect<Transferred, TransferError>;
    // `sm worktrees mirror`: a send that stays, or with --from a bring
    // that stays.
    readonly mirror: (
      here: Worktrees.Here,
      target: Worktrees.Target,
      flags: TransferFlags,
      onProgress: OnProgress,
    ) => Effect.Effect<Transferred, TransferError>;
    // `sm worktrees unmirror`: the mirror stopped and its copy removed.
    readonly unmirror: (
      here: Worktrees.Here,
      target: Worktrees.Target,
      options: { readonly force: boolean },
    ) => Effect.Effect<Unmirrored, ResolveError | ReadError | StopUnconfirmed>;
    // `sm worktrees mirrors`: the mirrors this device is part of.
    readonly mirrors: Effect.Effect<Ok<MirrorList>, ReadError>;
    // `sm devices`, inside a project or naming one, each device saying
    // whether it could take part.
    readonly devices: (
      here: Worktrees.Here,
      ref: ProjectRef,
    ) => Effect.Effect<Ok<DeviceList>, ResolveError | ReadError>;
    // `sm worktrees list --remote`: the project's worktrees on the other
    // devices, or on the one `from` names.
    readonly peerWorktrees: (
      here: Worktrees.Here,
      ref: Pick<Worktrees.Target, "project" | "projectId"> & {
        readonly from?: string | undefined;
      },
    ) => Effect.Effect<
      PeerWorktrees,
      TransferRefused | ResolveError | ReadError
    >;
  }
>()("sm/engine/Transfer") {}

// --- the pure parts -------------------------------------------------------

const refused = (
  binary: string,
  reason: TransferRefused["reason"],
  flagName = "",
) => new TransferRefused({ reason, flag: flagName, binary });

const isLeaveOut = Schema.is(ControlLeaveOutSchema);
const isSourceFate = Schema.is(ControlSourceFateSchema);

// The options every transfer takes, as the control op takes them.
// Nothing asked is nothing sent: the app then applies the project's
// saved leave-out rule and the setup default that goes with it. `sent`
// is the direction: --clone-into names a folder on the device a send
// goes to, and a bring lands in this device's own checkout.
export const transferOptions = (
  flags: TransferFlags,
  options: {
    readonly device: string | undefined;
    readonly mirror: boolean;
    readonly sent: boolean;
    readonly binary: string;
  },
): Effect.Effect<Record<string, unknown>, TransferRefused> => {
  const fail = (reason: TransferRefused["reason"]) =>
    Effect.fail(refused(options.binary, reason));
  const input: Record<string, unknown> = {};
  if (options.device !== undefined && options.device !== "") {
    input["device"] = options.device;
  }
  if (options.mirror) input["mirror"] = true;
  const rule = flags.leaveOut ?? "";
  if (rule !== "") {
    if (!isLeaveOut(rule)) return fail("leave-out");
    input["leaveOut"] = rule;
  }
  if (flags.setup === true && flags.noSetup === true) return fail("setup-both");
  if (flags.setup === true) input["setup"] = true;
  if (flags.noSetup === true) input["setup"] = false;
  const fate = flags.source ?? "";
  if (fate !== "") {
    if (options.mirror) return fail("mirror-source");
    if (!isSourceFate(fate)) return fail("source");
    input["source"] = fate;
  }
  if (flags.cloneInto !== undefined) {
    if (!options.sent) return fail("clone-into-bring");
    if (flags.cloneInto.trim() === "") return fail("clone-into-blank");
    input["cloneInto"] = flags.cloneInto;
  }
  return Effect.succeed(input);
};

// What became of a source whose fate was carried out.
const SOURCE_FATE_DONE: Partial<Record<SourceOutcome["fate"], string>> = {
  shelve: "shelved",
  teardown: "removed",
};
export const sourceFateDone = (fate: string): string =>
  isSourceFate(fate) ? (SOURCE_FATE_DONE[fate] ?? "") : "";

// The work landed, but something that should have followed it didn't:
// the uncommitted changes weren't applied on the copy, the ignored files
// didn't cross, or the source's fate couldn't be carried out.
export const caveatsOf = (result: TransferResult): ReadonlyArray<string> => [
  ...(result.captured && !result.dirtyApplied
    ? [
        "the uncommitted changes did not apply on the copy, so they exist only on the source",
      ]
    : []),
  ...((result.files?.error ?? "") !== ""
    ? [`the ignored files did not all cross: ${result.files?.error}`]
    : []),
  ...(result.source !== undefined && !result.source.done
    ? [
        `the source was not ${sourceFateDone(result.source.fate)}: ${result.source.error ?? ""}`,
      ]
    : []),
];

export const headlineOf = (
  result: TransferResult,
  direction: { readonly mirror: boolean; readonly sent: boolean },
): string => {
  const name = result.worktree.name;
  const device = `"${result.device.name}"`;
  if (result.alreadyMirrored) {
    return `${name} is already mirrored with ${device}`;
  }
  const headline = direction.mirror
    ? direction.sent
      ? `mirroring ${name} to ${device}`
      : `mirroring ${name} from ${device}`
    : direction.sent
      ? `sent ${name} to ${device}`
      : `brought ${name} from ${device}`;
  return result.cloned === undefined
    ? headline
    : `${headline}, having cloned ${result.cloned.name} into ${result.cloned.path} on ${device} first`;
};

const STEP_LABELS: ReadonlyMap<string, string> = new Map([
  ["clone", "cloning the repo"],
  ["capture", "capturing uncommitted changes"],
  ["transfer", "transferring commits"],
  ["create", "creating the worktree"],
  ["apply", "applying uncommitted changes"],
  ["files", "copying ignored files"],
]);

// A step's line: its label, and the create phase while one runs.
const stepLine = ({ step, createPhase }: SyncPullProgress): string => {
  const label = STEP_LABELS.get(step) ?? step;
  return createPhase === undefined ? label : `${label} (${createPhase})`;
};

// The app's own document, whole, with the fields beside it.
const appDocument = <T extends object>(answer: T): Ok<T> => ({
  ...answer,
  ok: true,
});

// --- the service ----------------------------------------------------------

const make = Effect.gen(function* () {
  const control = yield* Control.Control;
  const worktrees = yield* Worktrees.Worktrees;
  const { binaryName: binary } = yield* Paths.Paths;

  // A call's answer as the contracts type it: the loopback's RpcClient
  // decoded it against LoopbackGroup before Control handed it on.
  const invoke = <T>(
    channel: string,
    input: unknown,
    onPush?: (pushed: string, payload: unknown) => Effect.Effect<void>,
  ) => control.call(channel, input, onPush) as Effect.Effect<T, ReadError>;

  // A blank device is refused, not read as none: an unset shell
  // variable in `--from "$DEVICE"` would otherwise read as no direction,
  // and turn a bring into a send to whichever device qualifies.
  const checkDeviceFlags = (flags: TransferFlags) => {
    for (const name of ["to", "from"] as const) {
      const value = flags[name];
      if (value !== undefined && value.trim() === "") {
        return Effect.fail(refused(binary, "blank-device", name));
      }
    }
    return Effect.void;
  };

  // Progress as the app streams it, each sync:pullProgress push.
  const progressOf = (onProgress: OnProgress) => {
    let last = "";
    return (channel: string, payload: unknown) => {
      if (channel !== "sync:pullProgress") return Effect.void;
      const pushed = payload as SyncPullProgress;
      const line = stepLine(pushed);
      const fresh = line !== last;
      if (fresh) last = line;
      return onProgress({
        document: { ...pushed, event: "progress" },
        line: fresh ? line : undefined,
      });
    };
  };

  const transferred = Effect.fn(function* (
    channel: string,
    input: Record<string, unknown>,
    direction: { readonly mirror: boolean; readonly sent: boolean },
    onProgress: OnProgress,
  ) {
    const result = yield* invoke<ControlTransferResult>(
      channel,
      input,
      progressOf(onProgress),
    );
    return {
      document: { ...appDocument(result), caveats: caveatsOf(result) },
      headline: headlineOf(result, direction),
      result,
    };
  });

  // One of this device's worktrees to another device: moved, or with
  // `mirror` kept in step there. The primary checkout goes only as a
  // mirror (its copy lands on mirror/<branch> there), which the app says.
  const runSend = Effect.fn(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    mirror: boolean,
    onProgress: OnProgress,
  ) {
    const located = yield* worktrees.resolve(here, target);
    const input = yield* transferOptions(flags, {
      device: flags.to,
      mirror,
      sent: true,
      binary,
    });
    return yield* transferred(
      "control:send",
      {
        ...input,
        projectId: located.project.id,
        worktreeId: located.worktree.id,
      },
      { mirror, sent: true },
      onProgress,
    );
  });

  // One of another device's worktrees to this one, the same two ways.
  const runBring = Effect.fn(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    mirror: boolean,
    onProgress: OnProgress,
  ) {
    const project = yield* worktrees.resolveProjectRef(here, target);
    const wanted = target.ref ?? "";
    if (wanted === "") return yield* refused(binary, "no-worktree");
    const input = yield* transferOptions(flags, {
      device: flags.from,
      mirror,
      sent: false,
      binary,
    });
    return yield* transferred(
      "control:bring",
      { ...input, projectId: project.id, worktree: wanted },
      { mirror, sent: false },
      onProgress,
    );
  });

  const send = Effect.fn("Transfer.send")(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    onProgress: OnProgress,
  ) {
    yield* checkDeviceFlags(flags);
    if ((flags.from ?? "") !== "") {
      return yield* refused(binary, "send-direction");
    }
    return yield* runSend(here, target, flags, false, onProgress);
  });

  const bring = Effect.fn("Transfer.bring")(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    onProgress: OnProgress,
  ) {
    yield* checkDeviceFlags(flags);
    if ((flags.to ?? "") !== "") {
      return yield* refused(binary, "bring-direction");
    }
    return yield* runBring(here, target, flags, false, onProgress);
  });

  const mirror = Effect.fn("Transfer.mirror")(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    onProgress: OnProgress,
  ) {
    yield* checkDeviceFlags(flags);
    const from = flags.from ?? "";
    if ((flags.to ?? "") !== "" && from !== "") {
      return yield* refused(binary, "mirror-both");
    }
    return from === ""
      ? yield* runSend(here, target, flags, true, onProgress)
      : yield* runBring(here, target, flags, true, onProgress);
  });

  // Stops the mirror the worktree is part of and removes the copy,
  // whichever side that is. The original stays.
  const unmirror = Effect.fn("Transfer.unmirror")(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    options: { readonly force: boolean },
  ) {
    const located = yield* worktrees.resolve(here, target);
    const stopped = yield* invoke<MirrorStop>("control:mirrorStop", {
      projectId: located.project.id,
      worktreeId: located.worktree.id,
      ...(options.force ? { force: true } : {}),
    }).pipe(
      Effect.catchTags({
        ControlRefused: (error) =>
          error.code === "stop-unconfirmed"
            ? Effect.fail(new StopUnconfirmed({ said: error.said, binary }))
            : Effect.fail(error),
      }),
    );
    // The mirror stopped either way. A copy that stayed is the caveat.
    return {
      document: {
        ...appDocument(stopped),
        caveats:
          (stopped.copyStayed ?? "") === "" ? [] : [stopped.copyStayed ?? ""],
      },
      worktree: located.worktree,
    };
  });

  const mirrors = invoke<MirrorList>("control:mirrors", undefined).pipe(
    Effect.map(appDocument),
    Effect.withSpan("Transfer.mirrors"),
  );

  const devices = Effect.fn("Transfer.devices")(function* (
    here: Worktrees.Here,
    ref: ProjectRef,
  ) {
    const scoped =
      (ref.project ?? "") !== "" ||
      (ref.projectId ?? "") !== "" ||
      here.current !== undefined;
    const input = scoped
      ? { projectId: (yield* worktrees.resolveProjectRef(here, ref)).id }
      : {};
    return appDocument(yield* invoke<DeviceList>("control:devices", input));
  });

  const peerWorktrees = Effect.fn("Transfer.peerWorktrees")(function* (
    here: Worktrees.Here,
    ref: Pick<Worktrees.Target, "project" | "projectId"> & {
      readonly from?: string | undefined;
    },
  ) {
    yield* checkDeviceFlags({ from: ref.from });
    const project = yield* worktrees.resolveProjectRef(here, ref);
    const from = ref.from ?? "";
    const listed = yield* invoke<PeerWorktreeList>(
      "control:peerWorktrees",
      from === ""
        ? { projectId: project.id }
        : { projectId: project.id, device: from },
    );
    return {
      document: listed.worktrees.map(({ device, worktree }) => ({
        ...worktree,
        device,
      })),
      project,
      unreachable: listed.unreachable,
    };
  });

  return Transfer.of({
    send,
    bring,
    mirror,
    unmirror,
    mirrors,
    devices,
    peerWorktrees,
  });
});

export const layer = Layer.effect(Transfer, make);
