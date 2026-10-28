import * as Schema from "effect/Schema";
import { defineContract, invoke, Remote, view } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import {
  SyncCloneIntoSchema,
  SyncPullProgressSchema,
  SyncPullWorktreeResultSchema,
} from "./sync.ts";
import {
  ClonedFromDeviceSchema,
  VoidSchema,
  WorktreeIdSchema,
  WorktreeSchema,
} from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// The CLI's cross-device verbs, which need the account and the direct
// sessions only the running app holds. Loopback only: its caller is a
// local process of this user, which commands this machine without a
// grant.

// In the dialogs' order.
const ControlDeviceBlockSchema = Schema.Literals([
  "offline",
  "not-sharing",
  "no-project",
  "no-grant",
  // Up, but its answer to the ask was a refusal (a protocol mismatch),
  // said in `refusal`.
  "refused",
]);

const ControlDeviceSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    name: Schema.String,
    platform: Schema.String,
    // Without a project asked about, only `offline` and `not-sharing`
    // can be told. `no-project` still takes a send (it clones first).
    block: Schema.optional(ControlDeviceBlockSchema),
    refusal: Schema.optional(Schema.String),
    projectId: Schema.optional(Schema.String),
  }),
);
export type ControlDevice = typeof ControlDeviceSchema.Type;

// An id, a name, or an unambiguous start of one, case-insensitively.
// Absent picks the only device that qualifies.
const DeviceQuerySchema = Schema.optional(
  Schema.String.check(Schema.isBetweenLength(1, 256)),
);

// Absent: the project's saved rule.
export const ControlLeaveOutSchema = Schema.Literals(["nothing", "gitignored"]);

// Never read for a mirror, whose source stays.
export const ControlSourceFateSchema = Schema.Literals([
  "keep",
  "shelve",
  "teardown",
]);

const TransferOptionsSchema = Schema.Struct({
  device: DeviceQuerySchema,
  mirror: Schema.optional(Schema.Boolean),
  leaveOut: Schema.optional(ControlLeaveOutSchema),
  // Absent follows the rule (setupDefaultFor).
  setup: Schema.optional(Schema.Boolean),
  source: Schema.optional(ControlSourceFateSchema),
});

// The folder the checkout goes in, on the device it lands on (`~` is
// that device's home). Absent: the source's own layout, the two homes
// swapped.
const ControlCloneIntoSchema = Schema.optional(
  SyncCloneIntoSchema.struct.fields.parentDir.check(Schema.isMaxLength(4096)),
);

const ControlSendPayloadSchema = strict(
  Schema.Struct({
    ...TransferOptionsSchema.fields,
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
    cloneInto: ControlCloneIntoSchema,
  }),
);

const ControlBringPayloadSchema = strict(
  Schema.Struct({
    ...TransferOptionsSchema.fields,
    // This device's checkout, which names the repo to look for.
    projectId: Schema.NonEmptyString,
    // The peer's worktree: id, folder name or branch.
    worktree: Schema.String.check(Schema.isBetweenLength(1, 512)),
  }),
);

const ControlSourceOutcomeSchema = strict(
  Schema.Struct({
    fate: ControlSourceFateSchema,
    // The transfer stands either way.
    done: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
);

const ControlDeviceRefSchema = strict(
  Schema.Struct({ deviceId: DeviceIdSchema, name: Schema.String }),
);
const CopySideSchema = Schema.Literals(["local", "remote"]);

export const ControlTransferResultSchema = strict(
  Schema.Struct({
    ...SyncPullWorktreeResultSchema.struct.fields,
    device: ControlDeviceRefSchema,
    // Where `worktree` (the copy) is; its path means something only when
    // local.
    copySide: CopySideSchema,
    session: Schema.optional(Schema.String),
    // Nothing moved: `worktree` is the running session's copy.
    alreadyMirrored: Schema.optional(Schema.Boolean),
    source: Schema.optional(ControlSourceOutcomeSchema),
  }),
);
export type ControlTransferResult = typeof ControlTransferResultSchema.Type;

const ControlTransferEventSchema = Schema.Union([
  Schema.TaggedStruct("progress", { progress: SyncPullProgressSchema }),
  Schema.TaggedStruct("result", { result: ControlTransferResultSchema }),
]);
export type ControlTransferEvent = typeof ControlTransferEventSchema.Type;

// A project set up on a device that lacks it: another device's here
// (`from`), or this device's on the peer `device` names (`to`).
const ControlClonePayloadSchema = Schema.Union([
  strict(
    Schema.TaggedStruct("from", {
      device: DeviceQuerySchema,
      // The peer's project: its id, its name, or its path there.
      project: Schema.String.check(Schema.isBetweenLength(1, 4096)),
      cloneInto: ControlCloneIntoSchema,
    }),
  ),
  strict(
    Schema.TaggedStruct("to", {
      device: Schema.String.check(Schema.isBetweenLength(1, 256)),
      projectId: Schema.NonEmptyString,
      cloneInto: ControlCloneIntoSchema,
    }),
  ),
]);

const ControlCloneResultSchema = strict(
  Schema.Struct({
    ...ClonedFromDeviceSchema.fields,
    device: ControlDeviceRefSchema,
  }),
);
export type ControlCloneResult = typeof ControlCloneResultSchema.Type;

const ControlCloneEventSchema = Schema.Union([
  Schema.TaggedStruct("progress", { progress: SyncPullProgressSchema }),
  Schema.TaggedStruct("result", { result: ControlCloneResultSchema }),
]);

const ControlPeerWorktreeSchema = strict(
  Schema.Struct({
    device: ControlDeviceRefSchema,
    projectId: Schema.String,
    worktree: WorktreeSchema,
  }),
);
export type ControlPeerWorktree = typeof ControlPeerWorktreeSchema.Type;

// Seen from this device whichever side runs it.
const DeviceNameSchema = strict(
  Schema.Struct({ deviceId: Schema.String, name: Schema.String }),
);
const ControlMirrorSchema = strict(
  Schema.Struct({
    session: Schema.String,
    device: DeviceNameSchema,
    localProjectId: Schema.String,
    localWorktreeId: Schema.String,
    localRoot: Schema.String,
    remoteRoot: Schema.String,
    // Where the copy a stop removes is.
    copySide: CopySideSchema,
    paused: Schema.Boolean,
    status: Schema.String,
    statusText: Schema.String,
    git: Schema.optional(Schema.String),
    gitDetail: Schema.optional(Schema.String),
    conflicts: Schema.Natural,
  }),
);
export type ControlMirror = typeof ControlMirrorSchema.Type;

const ControlMirrorTargetSchema = Schema.Struct({
  projectId: Schema.NonEmptyString,
  worktreeId: WorktreeIdSchema,
});

export const controlContract = defineContract(
  "control",
  "host",
  invoke(
    "devices",
    strict(
      Schema.Struct({ projectId: Schema.optional(Schema.NonEmptyString) }),
    ),
    strict(
      Schema.Struct({
        thisDevice: DeviceNameSchema,
        devices: Schema.Array(ControlDeviceSchema),
      }),
    ),
  ),
  // Primary checkouts are left out: only a worktree moves.
  invoke(
    "peerWorktrees",
    strict(
      Schema.Struct({
        projectId: Schema.NonEmptyString,
        device: DeviceQuerySchema,
      }),
    ),
    strict(
      Schema.Struct({
        worktrees: Schema.Array(ControlPeerWorktreeSchema),
        // So an empty list is never mistaken for "nothing there".
        unreachable: Schema.Array(Schema.String),
      }),
    ),
  ),
  // Streams progress, then the answer.
  view("send", ControlSendPayloadSchema, ControlTransferEventSchema, {
    gated: true,
  }),
  // Progress is keyed by the peer's worktree id.
  view("bring", ControlBringPayloadSchema, ControlTransferEventSchema, {
    gated: true,
  }),
  // Streams the clone's progress (a clone here only), then the answer.
  view("clone", ControlClonePayloadSchema, ControlCloneEventSchema, {
    gated: true,
  }),
  invoke(
    "mirrors",
    VoidSchema,
    strict(
      Schema.Struct({
        daemon: Schema.String,
        daemonFailure: Schema.String,
        mirrors: Schema.Array(ControlMirrorSchema),
      }),
    ),
  ),
  // Refused unless in step, as mirror:stop is, until `force`.
  invoke(
    "mirrorStop",
    strict(
      Schema.Struct({
        ...ControlMirrorTargetSchema.fields,
        force: Schema.optional(Schema.Boolean),
      }),
    ),
    strict(
      Schema.Struct({
        mirror: ControlMirrorSchema,
        // Why the copy couldn't be removed.
        copyStayed: Schema.optional(Schema.String),
      }),
    ),
    { gated: true },
  ),
).annotateRpcs(Remote, false);

// So the CLI keys its exit handling on a code, not the prose.
export const CONTROL_ERROR_CODES = [
  "no-device",
  "ambiguous-device",
  "device-blocked",
  "no-worktree",
  "ambiguous-worktree",
  "no-project",
  "ambiguous-project",
  "no-mirror",
  "stop-unconfirmed",
  "signed-out",
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export function isControlErrorCode(code: unknown): code is ControlErrorCode {
  return (CONTROL_ERROR_CODES as readonly unknown[]).includes(code);
}

export class ControlError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}
