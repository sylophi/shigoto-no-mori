import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { SyncCloneIntoSchema, SyncPullWorktreeResultSchema } from "./sync.ts";
import {
  VoidSchema,
  WorktreeIdSchema,
  WorktreeSchema,
} from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// What the CLI asks of the running app: the cross-device verbs (`sm
// worktrees send|bring|mirror|unmirror|mirrors`, `sm devices`). Reaching
// another device takes the account and the one cached direct session
// per peer, which only the running app holds, so these verbs ride the
// control wire (main/core/control/server.ts) into the app. It runs the
// orchestrators its own dialogs do, which shell the CLI back for each
// git step.
//
// Served on the control wire ONLY (main/ipc/handlers.ts), so every call
// says remote: false. Its caller is a local process of this user and
// commands this machine without a grant. `gated` is what pings the
// app's windows and the remote viewers once an op moved state.
//
// Each op takes what a person would say (a device by name, a worktree
// by name or branch) and resolves it the way the dialogs do.

// Why a device can't take part, in the dialogs' order
// (renderer/components/shared/deviceTargets.ts).
const ControlDeviceBlockSchema = Schema.Literals([
  "offline",
  "no-project",
  "no-grant",
]);

const ControlDeviceSchema = strict(
  Schema.Struct({
    deviceId: DeviceIdSchema,
    name: Schema.String,
    platform: Schema.String,
    // Absent when no project was asked about: then only `offline` can be
    // told. With one, absent means the device can take a send or serve a
    // bring. `no-project` still takes a send (which clones the repo there
    // first) but cannot serve a bring.
    block: Schema.optional(ControlDeviceBlockSchema),
    // The repo's checkout on that device, when it holds one.
    projectId: Schema.optional(Schema.String),
  }),
);
export type ControlDevice = typeof ControlDeviceSchema.Type;

// A device as the caller names it: its id, its name, or an unambiguous
// start of its name, case-insensitively. Absent picks the only device
// that qualifies, and refuses when several do.
const DeviceQuerySchema = Schema.optional(
  Schema.String.check(Schema.isBetweenLength(1, 256)),
);

// The leave-out rule by name. Absent is the project's saved rule, what
// the review step opens on.
const ControlLeaveOutSchema = Schema.Literals(["nothing", "gitignored"]);

// What becomes of the source once a transplant landed, the finish
// step's three fates. Never read for a mirror, whose source stays.
const ControlSourceFateSchema = Schema.Literals(["keep", "shelve", "teardown"]);

const TransferOptionsSchema = Schema.Struct({
  device: DeviceQuerySchema,
  // A mirror keeps the two in step until stopped. Absent or false is a
  // one-shot transplant.
  mirror: Schema.optional(Schema.Boolean),
  leaveOut: Schema.optional(ControlLeaveOutSchema),
  // Absent follows the rule (shared/leaveOutRule.ts setupDefaultFor).
  setup: Schema.optional(Schema.Boolean),
  source: Schema.optional(ControlSourceFateSchema),
});

const ControlSendPayloadSchema = strict(
  Schema.Struct({
    ...TransferOptionsSchema.fields,
    projectId: Schema.NonEmptyString,
    worktreeId: WorktreeIdSchema,
    // Where the target clones the repo when it has no checkout of it: the
    // folder the checkout goes in, on the target (a leading `~` is its
    // home). Absent is the dialogs' default. Unread when the target holds
    // the repo.
    cloneInto: Schema.optional(
      SyncCloneIntoSchema.struct.fields.parentDir.check(
        Schema.isMaxLength(4096),
      ),
    ),
  }),
);

const ControlBringPayloadSchema = strict(
  Schema.Struct({
    ...TransferOptionsSchema.fields,
    // THIS device's checkout of the repo, which names the repo to look
    // for on the peers.
    projectId: Schema.NonEmptyString,
    // The peer's worktree: its id, its folder name or its branch.
    worktree: Schema.String.check(Schema.isBetweenLength(1, 512)),
  }),
);

const ControlSourceOutcomeSchema = strict(
  Schema.Struct({
    fate: ControlSourceFateSchema,
    // False when the fate could not be carried out, with the reason. The
    // transfer itself still stands.
    done: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
);

const ControlDeviceRefSchema = strict(
  Schema.Struct({ deviceId: DeviceIdSchema, name: Schema.String }),
);
const CopySideSchema = Schema.Literals(["local", "remote"]);

const ControlTransferResultSchema = strict(
  Schema.Struct({
    ...SyncPullWorktreeResultSchema.struct.fields,
    device: ControlDeviceRefSchema,
    // Which device `worktree` (the copy) is on: "remote" for a send,
    // "local" for a bring. Its path means something here only when local.
    copySide: CopySideSchema,
    // The mirror session, when one was asked for.
    session: Schema.optional(Schema.String),
    // The worktree was already mirrored with that device: nothing moved,
    // and `worktree` is the copy the running session keeps.
    alreadyMirrored: Schema.optional(Schema.Boolean),
    source: Schema.optional(ControlSourceOutcomeSchema),
  }),
);
export type ControlTransferResult = typeof ControlTransferResultSchema.Type;

export const ControlPeerWorktreeSchema = strict(
  Schema.Struct({
    device: ControlDeviceRefSchema,
    projectId: Schema.String,
    worktree: WorktreeSchema,
  }),
);
export type ControlPeerWorktree = typeof ControlPeerWorktreeSchema.Type;

// A mirror this device is part of, reduced to what a terminal says
// about it, and seen from this device whichever side runs it: `local`
// is this device's worktree, `device` the other one.
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
    // Which side is the copy a stop removes: "remote" when it is on the
    // other device, "local" when it is here.
    copySide: CopySideSchema,
    paused: Schema.Boolean,
    status: Schema.String,
    statusText: Schema.String,
    // The git follower's verdict. "synced" is the one state a stop is
    // safe in without force.
    git: Schema.optional(Schema.String),
    gitDetail: Schema.optional(Schema.String),
    conflicts: Schema.Natural,
  }),
);
export type ControlMirror = typeof ControlMirrorSchema.Type;

const ControlMirrorTargetSchema = Schema.Struct({
  projectId: Schema.NonEmptyString,
  // This device's side of the mirror, original or copy.
  worktreeId: WorktreeIdSchema,
});

export const controlContract = defineContract(
  "control",
  "host",
  // The account's other project-hosting devices. With a project, each
  // says whether it could take a send of it or serve a bring.
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
    { remote: false },
  ),
  // The repo's worktrees on the other devices, the candidates for a
  // bring. Primary checkouts are left out: only a worktree moves.
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
        // The devices that hold the repo's account but could not be
        // asked, by name, so an empty list is never mistaken for "there
        // is nothing there".
        unreachable: Schema.Array(Schema.String),
      }),
    ),
    { remote: false },
  ),
  // One of this device's worktrees to a peer: a transplant, or with
  // `mirror` a mirror whose copy is there. A peer with no checkout of
  // the repo clones it first. Progress streams to the caller as
  // sync:pullProgress frames, keyed by the local worktree.
  invoke("send", ControlSendPayloadSchema, ControlTransferResultSchema, {
    remote: false,
    gated: true,
  }),
  // A peer's worktree to this device, the same two ways. Progress is
  // keyed by the peer's worktree id.
  invoke("bring", ControlBringPayloadSchema, ControlTransferResultSchema, {
    remote: false,
    gated: true,
  }),
  invoke(
    "mirrors",
    VoidSchema,
    strict(
      Schema.Struct({
        daemon: Schema.String,
        mirrors: Schema.Array(ControlMirrorSchema),
      }),
    ),
    { remote: false },
  ),
  // Ends the mirror the worktree is part of and removes the copy,
  // wherever it is. Refused unless the follower reports "synced", as
  // mirror:stop is, until `force`.
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
        // The mirror stopped but its copy could not be removed, with the
        // reason. Absent when the copy went too.
        copyStayed: Schema.optional(Schema.String),
      }),
    ),
    { remote: false, gated: true },
  ),
);

// The failure codes a control op's refusal carries across the wire, so
// the CLI keys its exit handling on the code and not on the prose.
const CONTROL_ERROR_CODES = [
  "no-device",
  "ambiguous-device",
  "device-blocked",
  "no-worktree",
  "ambiguous-worktree",
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
