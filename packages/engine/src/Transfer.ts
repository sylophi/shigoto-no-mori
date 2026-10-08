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
// prints, with what the terminal's lines read beside them.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Control from "./Control.ts";
import type * as Git from "./Git.ts";
import type { Document } from "./Landing.ts";
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

// A progress push: the event `sm --json` prints for it (none for a
// payload that isn't an object), and the step's line when it differs
// from the one before (a transfer pushes per chunk).
export type Progress = {
  readonly document: Document | undefined;
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
}

// The app's answer isn't the shape this build reads.
export class UnreadableAnswer extends Schema.TaggedError<UnreadableAnswer>()(
  "UnreadableAnswer",
  { channel: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The app answered ${this.channel} with something this CLI can't read. The two may be different versions.`;
  }
}

// --- the slices of the app's documents ------------------------------------

// Absent reads as empty, as Go's zero values.
const text = Schema.String.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("")),
);
const flag = Schema.Boolean.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(false)),
);
const count = Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)));
const list = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));

const NamedDeviceSchema = Schema.Struct({ deviceId: text, name: text });
export type NamedDevice = typeof NamedDeviceSchema.Type;
const namedDevice = NamedDeviceSchema.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed({})),
);

const WorktreeSliceSchema = Schema.Struct({
  name: text,
  branch: text,
  path: text,
});

const TransferResultSchema = Schema.Struct({
  worktree: WorktreeSliceSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  captured: flag,
  dirtyApplied: flag,
  device: namedDevice,
  copySide: text,
  alreadyMirrored: flag,
  // The project the other device cloned first, having no checkout of
  // the repo.
  cloned: Schema.optional(Schema.Struct({ name: text, path: text })),
  files: Schema.optional(Schema.Struct({ crossed: flag, error: text })),
  source: Schema.optional(
    Schema.Struct({ fate: text, done: flag, error: text }),
  ),
});
export type TransferResult = typeof TransferResultSchema.Type;

const MirrorSchema = Schema.Struct({
  device: namedDevice,
  localRoot: text,
  copySide: text,
  paused: flag,
  status: text,
  git: text,
  conflicts: count,
});
export type Mirror = typeof MirrorSchema.Type;

const DeviceSchema = Schema.Struct({ name: text, platform: text, block: text });
export type Device = typeof DeviceSchema.Type;

const PeerWorktreesSchema = Schema.Struct({
  worktrees: list(
    Schema.Struct({
      device: namedDevice,
      worktree: Schema.optional(Schema.Unknown),
    }),
  ),
  unreachable: list(Schema.String),
});

const MirrorStopSchema = Schema.Struct({
  mirror: MirrorSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  copyStayed: text,
});

const MirrorsSchema = Schema.Struct({
  daemon: text,
  mirrors: list(MirrorSchema),
});

const DevicesSchema = Schema.Struct({
  thisDevice: namedDevice,
  devices: list(DeviceSchema),
});

const ProgressSchema = Schema.Struct({ step: text, createPhase: text });

// --- what the verbs answer ------------------------------------------------

// A finished send, bring or mirror: the document, what didn't hold (the
// terminal exits 3 when anything didn't), the headline, and the answer.
export type Transferred = {
  readonly document: Document;
  readonly caveats: ReadonlyArray<string>;
  readonly headline: string;
  readonly result: TransferResult;
};

// A project's worktrees on the other devices: the document (list's
// shape, each saying whose it is), the devices that weren't asked, and
// a row per worktree.
export type PeerWorktrees = {
  readonly document: ReadonlyArray<Document>;
  readonly project: RegisteredProject;
  readonly unreachable: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{
    readonly name: string;
    readonly branch: string;
    readonly device: NamedDevice;
  }>;
};

// A stopped mirror. A copy that stayed is its caveat.
export type Unmirrored = {
  readonly document: Document;
  readonly caveats: ReadonlyArray<string>;
  readonly worktree: Worktrees.WorktreeIdentity;
  readonly mirror: Mirror;
};

export type Mirrors = {
  readonly document: Document;
  readonly daemon: string;
  readonly mirrors: ReadonlyArray<Mirror>;
};

// The account's other devices. `scoped` is whether a project was asked
// about, so each says whether it could take part.
export type Devices = {
  readonly document: Document;
  readonly scoped: boolean;
  readonly thisDevice: NamedDevice;
  readonly devices: ReadonlyArray<Device>;
};

type ResolveError =
  | Worktrees.TargetError
  | Worktrees.UnknownWorktree
  | Registry.UnknownProject
  | Git.GitError;

type TransferError =
  | TransferRefused
  | ResolveError
  | Control.ControlError
  | UnreadableAnswer;

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
    ) => Effect.Effect<
      Unmirrored,
      ResolveError | Control.ControlError | UnreadableAnswer | StopUnconfirmed
    >;
    // `sm worktrees mirrors`: the mirrors this device is part of.
    readonly mirrors: Effect.Effect<
      Mirrors,
      Control.ControlError | UnreadableAnswer
    >;
    // `sm devices`, inside a project or naming one with -p or its id.
    readonly devices: (
      here: Worktrees.Here,
      ref: {
        readonly project?: string | undefined;
        readonly projectId?: string | undefined;
      },
    ) => Effect.Effect<
      Devices,
      ResolveError | Control.ControlError | UnreadableAnswer
    >;
    // `sm worktrees list --remote`: the project's worktrees on the other
    // devices, or on the one `from` names.
    readonly peerWorktrees: (
      here: Worktrees.Here,
      ref: {
        readonly project?: string | undefined;
        readonly from?: string | undefined;
      },
    ) => Effect.Effect<
      PeerWorktrees,
      ResolveError | Control.ControlError | UnreadableAnswer
    >;
  }
>()("sm/engine/Transfer") {}

// --- the pure parts -------------------------------------------------------

const refused = (
  binary: string,
  reason: TransferRefused["reason"],
  flagName = "",
) => new TransferRefused({ reason, flag: flagName, binary });

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
    if (rule !== "nothing" && rule !== "gitignored") return fail("leave-out");
    input["leaveOut"] = rule;
  }
  if (flags.setup === true && flags.noSetup === true) return fail("setup-both");
  if (flags.setup === true) input["setup"] = true;
  if (flags.noSetup === true) input["setup"] = false;
  const fate = flags.source ?? "";
  if (fate !== "") {
    if (options.mirror) return fail("mirror-source");
    if (fate !== "keep" && fate !== "shelve" && fate !== "teardown") {
      return fail("source");
    }
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
const SOURCE_FATE_DONE: Readonly<Record<string, string>> = {
  shelve: "shelved",
  teardown: "removed",
};

// The work landed, but something that should have followed it didn't:
// the uncommitted changes weren't applied on the copy, the ignored files
// didn't cross, or the source's fate couldn't be carried out.
export const caveatsOf = (result: TransferResult): ReadonlyArray<string> => [
  ...(result.captured && !result.dirtyApplied
    ? [
        "the uncommitted changes did not apply on the copy, so they exist only on the source",
      ]
    : []),
  ...(result.files !== undefined && result.files.error !== ""
    ? [`the ignored files did not all cross: ${result.files.error}`]
    : []),
  ...(result.source !== undefined && !result.source.done
    ? [
        `the source was not ${SOURCE_FATE_DONE[result.source.fate] ?? ""}: ${result.source.error}`,
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

const STEP_LABELS: Readonly<Record<string, string>> = {
  clone: "cloning the repo",
  capture: "capturing uncommitted changes",
  transfer: "transferring commits",
  create: "creating the worktree",
  apply: "applying uncommitted changes",
  files: "copying ignored files",
};

// A step's line: its label, and the create phase while one runs.
const stepLine = (payload: unknown): string | undefined => {
  const decoded = Schema.decodeUnknownOption(ProgressSchema)(payload);
  if (Option.isNone(decoded)) return undefined;
  const { step, createPhase } = decoded.value;
  const label = STEP_LABELS[step] ?? step;
  return createPhase !== "" && createPhase !== "idle"
    ? `${label} (${createPhase})`
    : label;
};

const isDocument = (value: unknown): value is Document =>
  Predicate.isObject(value) && !Array.isArray(value);

// The app's own document, whole, with the fields beside it.
const appDocument = (
  raw: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Document => ({ ...(isDocument(raw) ? raw : {}), ok: true, ...extra });

// --- the service ----------------------------------------------------------

const make = Effect.gen(function* () {
  const control = yield* Control.Control;
  const worktrees = yield* Worktrees.Worktrees;
  const { binaryName: binary } = yield* Paths.Paths;

  // A call, its answer decoded into the slice the verb reads.
  const invoke = <S extends Schema.Decoder<unknown>>(
    schema: S,
    channel: string,
    input: unknown,
    onPush?: (pushed: string, payload: unknown) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const raw = yield* control.call(channel, input, onPush);
      const decoded = yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError((cause) => new UnreadableAnswer({ channel, cause })),
      );
      return { raw, decoded };
    });

  // A blank device is refused, not read as none: an unset shell
  // variable in `--from "$DEVICE"` would otherwise read as no direction,
  // and turn a bring into a send to whichever device qualifies.
  const checkDeviceFlags = (flags: TransferFlags) => {
    for (const [name, value] of Object.entries({
      to: flags.to,
      from: flags.from,
    })) {
      if (value !== undefined && value.trim() === "") {
        return Effect.fail(refused(binary, "blank-device", name));
      }
    }
    return Effect.void;
  };

  // The project a command names: by id, by -p, or the one at the cwd.
  const projectOf = (
    here: Worktrees.Here,
    ref: {
      readonly project?: string | undefined;
      readonly projectId?: string | undefined;
    },
  ) =>
    ref.projectId !== undefined && ref.projectId !== ""
      ? worktrees.resolveProjectById(here, ref.projectId)
      : worktrees.resolveProject(here, ref.project);

  // Progress as the app streams it, each sync:pullProgress push.
  const progressOf = (onProgress: OnProgress) => {
    let last = "";
    return (channel: string, payload: unknown) => {
      if (channel !== "sync:pullProgress") return Effect.void;
      const line = stepLine(payload);
      const fresh = line !== undefined && line !== last;
      if (fresh) last = line;
      return onProgress({
        document: isDocument(payload)
          ? { ...payload, event: "progress" }
          : undefined,
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
    const { raw, decoded } = yield* invoke(
      TransferResultSchema,
      channel,
      input,
      progressOf(onProgress),
    );
    const caveats = caveatsOf(decoded);
    return {
      document: appDocument(raw, { caveats }),
      caveats,
      headline: headlineOf(decoded, direction),
      result: decoded,
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
    const project = yield* projectOf(here, target);
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
    if ((flags.from ?? "") !== "")
      return yield* refused(binary, "send-direction");
    return yield* runSend(here, target, flags, false, onProgress);
  });

  const bring = Effect.fn("Transfer.bring")(function* (
    here: Worktrees.Here,
    target: Worktrees.Target,
    flags: TransferFlags,
    onProgress: OnProgress,
  ) {
    yield* checkDeviceFlags(flags);
    if ((flags.to ?? "") !== "")
      return yield* refused(binary, "bring-direction");
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
    const { raw, decoded } = yield* invoke(
      MirrorStopSchema,
      "control:mirrorStop",
      {
        projectId: located.project.id,
        worktreeId: located.worktree.id,
        ...(options.force ? { force: true } : {}),
      },
    ).pipe(
      Effect.catchTags({
        ControlRefused: (error) =>
          error.code === "stop-unconfirmed"
            ? Effect.fail(new StopUnconfirmed({ said: error.said, binary }))
            : Effect.fail(error),
      }),
    );
    // The mirror stopped either way. A copy that stayed is the caveat.
    const caveats = decoded.copyStayed === "" ? [] : [decoded.copyStayed];
    return {
      document: appDocument(raw, { caveats }),
      caveats,
      worktree: located.worktree,
      mirror: decoded.mirror,
    };
  });

  const mirrors = Effect.gen(function* () {
    const { raw, decoded } = yield* invoke(
      MirrorsSchema,
      "control:mirrors",
      undefined,
    );
    return {
      document: appDocument(raw),
      daemon: decoded.daemon,
      mirrors: decoded.mirrors,
    };
  }).pipe(Effect.withSpan("Transfer.mirrors"));

  const devices = Effect.fn("Transfer.devices")(function* (
    here: Worktrees.Here,
    ref: {
      readonly project?: string | undefined;
      readonly projectId?: string | undefined;
    },
  ) {
    const scoped =
      (ref.project ?? "") !== "" ||
      (ref.projectId ?? "") !== "" ||
      here.current !== undefined;
    const input = scoped ? { projectId: (yield* projectOf(here, ref)).id } : {};
    const { raw, decoded } = yield* invoke(
      DevicesSchema,
      "control:devices",
      input,
    );
    return {
      document: appDocument(raw),
      scoped,
      thisDevice: decoded.thisDevice,
      devices: decoded.devices,
    };
  });

  const peerWorktrees = Effect.fn("Transfer.peerWorktrees")(function* (
    here: Worktrees.Here,
    ref: {
      readonly project?: string | undefined;
      readonly from?: string | undefined;
    },
  ) {
    const project = yield* worktrees.resolveProject(here, ref.project);
    const from = ref.from ?? "";
    const { decoded } = yield* invoke(
      PeerWorktreesSchema,
      "control:peerWorktrees",
      from === ""
        ? { projectId: project.id }
        : { projectId: project.id, device: from },
    );
    const sliceOf = Schema.decodeUnknownOption(WorktreeSliceSchema);
    return {
      // Each named the way the device fields of Go's struct are.
      document: decoded.worktrees.map(({ device, worktree }) => ({
        ...(isDocument(worktree) ? worktree : {}),
        device: { deviceId: device.deviceId, name: device.name },
      })),
      project,
      unreachable: decoded.unreachable,
      rows: decoded.worktrees.map(({ device, worktree }) => {
        const slice = Option.getOrElse(sliceOf(worktree), () => ({
          name: "",
          branch: "",
          path: "",
        }));
        return { name: slice.name, branch: slice.branch, device };
      }),
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
