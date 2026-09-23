import { Schema } from "effect";
import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIdSchema } from "@shared/hub/protocol";
import { SyncPullWorktreeResultSchema } from "@shared/ipc/modules/sync";
import { WorktreeIdZod, WorktreeZod } from "@shared/schemas";

// What the CLI asks of the running app: the cross-device verbs (`sm
// worktrees send|bring|mirror|unmirror|mirrors`, `sm devices`). Reaching
// another device takes the account and the one cached direct session
// per peer, which only the running app holds, so these verbs ride the
// control wire (main/core/control/server.ts) into the app. It runs the
// orchestrators its own dialogs do, which shell the CLI back for each
// git step.
//
// Served on the control wire ONLY (main/ipc/handlers.ts), so no call
// carries a remote tag. Its caller is a local process of this user and
// commands this machine without a grant. `mutating` is what pings the
// app's windows and the remote viewers once an op moved state.
//
// Each op takes what a person would say (a device by name, a worktree
// by name or branch) and resolves it the way the dialogs do.

// Why a device can't take part, in the dialogs' order
// (renderer/components/shared/deviceTargets.ts).
const ControlDeviceBlockSchema = z.enum(["offline", "no-project", "no-grant"]);

const ControlDeviceSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  name: z.string(),
  platform: z.string(),
  // Absent when no project was asked about: then only `offline` can be
  // told. With one, absent means the device can take a send or serve a
  // bring.
  block: ControlDeviceBlockSchema.optional(),
  // The repo's checkout on that device, when it holds one.
  projectId: z.string().optional(),
});
export type ControlDevice = z.infer<typeof ControlDeviceSchema>;

// A device as the caller names it: its id, its name, or an unambiguous
// start of its name, case-insensitively. Absent picks the only device
// that qualifies, and refuses when several do.
const DeviceQuerySchema = z.string().min(1).max(256).optional();

// The leave-out rule by name. Absent is the project's saved rule, what
// the review step opens on.
const ControlLeaveOutSchema = z.enum(["nothing", "gitignored"]);

// What becomes of the source once a transplant landed, the finish
// step's three fates. Never read for a mirror, whose source stays.
const ControlSourceFateSchema = z.enum(["keep", "shelve", "teardown"]);

const TransferOptionsSchema = z.strictObject({
  device: DeviceQuerySchema,
  // A mirror keeps the two in step until stopped. Absent or false is a
  // one-shot transplant.
  mirror: z.boolean().optional(),
  leaveOut: ControlLeaveOutSchema.optional(),
  // Absent follows the rule (shared/leaveOutRule.ts setupDefaultFor).
  setup: z.boolean().optional(),
  source: ControlSourceFateSchema.optional(),
});

const ControlSendPayloadSchema = TransferOptionsSchema.extend({
  projectId: z.string().min(1),
  worktreeId: WorktreeIdZod,
});

const ControlBringPayloadSchema = TransferOptionsSchema.extend({
  // THIS device's checkout of the repo, which names the repo to look
  // for on the peers.
  projectId: z.string().min(1),
  // The peer's worktree: its id, its folder name or its branch.
  worktree: z.string().min(1).max(512),
});

const ControlSourceOutcomeSchema = z.strictObject({
  fate: ControlSourceFateSchema,
  // False when the fate could not be carried out, with the reason. The
  // transfer itself still stands.
  done: z.boolean(),
  error: z.string().optional(),
});

const ControlTransferResultSchema = SyncPullWorktreeResultSchema.extend({
  device: z.strictObject({ deviceId: DeviceIdSchema, name: z.string() }),
  // Which device `worktree` (the copy) is on: "remote" for a send,
  // "local" for a bring. Its path means something here only when local.
  copySide: z.enum(["local", "remote"]),
  // The mirror session, when one was asked for.
  session: z.string().optional(),
  // The worktree was already mirrored with that device: nothing moved,
  // and `worktree` is the copy the running session keeps.
  alreadyMirrored: z.boolean().optional(),
  source: ControlSourceOutcomeSchema.optional(),
});
export type ControlTransferResult = z.infer<typeof ControlTransferResultSchema>;

const ControlPeerWorktreeSchema = z.strictObject({
  device: z.strictObject({ deviceId: DeviceIdSchema, name: z.string() }),
  projectId: z.string(),
  worktree: WorktreeZod,
});
export type ControlPeerWorktree = z.infer<typeof ControlPeerWorktreeSchema>;

// A mirror this device runs, reduced to what a terminal says about it.
const ControlMirrorSchema = z.strictObject({
  session: z.string(),
  device: z.strictObject({ deviceId: z.string(), name: z.string() }),
  localProjectId: z.string(),
  localWorktreeId: z.string(),
  localRoot: z.string(),
  remoteRoot: z.string(),
  // Which side is the copy a stop removes: "remote" for a mirror
  // started to a peer, "local" for one brought here.
  copySide: z.enum(["local", "remote"]),
  paused: z.boolean(),
  status: z.string(),
  statusText: z.string(),
  // The git follower's verdict. "synced" is the one state a stop is
  // safe in without force.
  git: z.string().optional(),
  gitDetail: z.string().optional(),
  conflicts: z.number().int().nonnegative(),
});
export type ControlMirror = z.infer<typeof ControlMirrorSchema>;

const ControlMirrorTargetSchema = z.strictObject({
  projectId: z.string().min(1),
  // This device's side of the mirror, original or copy.
  worktreeId: WorktreeIdZod,
});

export const controlContract = defineContract("host", {
  // The account's other project-hosting devices. With a project, each
  // says whether it could take a send of it or serve a bring.
  devices: invoke(
    "control:devices",
    z.strictObject({ projectId: z.string().min(1).optional() }),
    z.strictObject({
      thisDevice: z.strictObject({ deviceId: z.string(), name: z.string() }),
      devices: z.array(ControlDeviceSchema),
    }),
  ),
  // The repo's worktrees on the other devices, the candidates for a
  // bring. Primary checkouts are left out: only a worktree moves.
  peerWorktrees: invoke(
    "control:peerWorktrees",
    z.strictObject({ projectId: z.string().min(1), device: DeviceQuerySchema }),
    z.strictObject({
      worktrees: z.array(ControlPeerWorktreeSchema),
      // The devices that hold the repo's account but could not be
      // asked, by name, so an empty list is never mistaken for "there
      // is nothing there".
      unreachable: z.array(z.string()),
    }),
  ),
  // One of this device's worktrees to a peer: a transplant, or with
  // `mirror` a mirror whose copy is there. Progress streams to the
  // caller as sync:pullProgress frames, keyed by the local worktree.
  send: invoke(
    "control:send",
    ControlSendPayloadSchema,
    ControlTransferResultSchema,
    { mutating: true },
  ),
  // A peer's worktree to this device, the same two ways. Progress is
  // keyed by the peer's worktree id.
  bring: invoke(
    "control:bring",
    ControlBringPayloadSchema,
    ControlTransferResultSchema,
    { mutating: true },
  ),
  mirrors: invoke(
    "control:mirrors",
    z.void(),
    z.strictObject({
      daemon: z.string(),
      mirrors: z.array(ControlMirrorSchema),
    }),
  ),
  // Ends the mirror the worktree is part of and removes the copy,
  // wherever it is. Refused unless the follower reports "synced", as
  // mirror:stop is, until `force`.
  mirrorStop: invoke(
    "control:mirrorStop",
    ControlMirrorTargetSchema.extend({ force: z.boolean().optional() }),
    z.strictObject({
      mirror: ControlMirrorSchema,
      // The mirror stopped but its copy could not be removed, with the
      // reason. Absent when the copy went too.
      copyStayed: z.string().optional(),
    }),
    { mutating: true },
  ),
});

// The failure codes a control op's refusal carries across the wire, so
// the CLI keys its exit handling on the code and not on the prose.
export const CONTROL_ERROR_CODES = [
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

// A control op's refusal. `code` is an own field, so the control wire
// (main/core/control/server.ts) reads it with errorCodeOf and sends it
// as the res frame's top-level `code`, which is what the Go CLI keys
// on, beside the encoded error.
export const CONTROL_ERROR_TAG = "ControlError";

export class ControlError extends Schema.TaggedError<ControlError>()(
  CONTROL_ERROR_TAG,
  { code: Schema.Literals(CONTROL_ERROR_CODES), message: Schema.String },
) {}
