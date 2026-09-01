import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { HexId32Schema } from "@shared/ipc/hexId";
import { ChunkB64Schema } from "@shared/ipc/socket/frames";
import { DeviceIdSchema } from "@shared/hub/protocol";
import {
  CommitHashSchema,
  GitRefNameSchema,
  WorktreeSchema,
} from "@shared/schemas";

// Device-sync transfer plumbing (v2 step 7, slice B): git bundles move
// between devices as chunked, grant-gated invoke responses over the
// existing device connection. No new wire protocol, no sidecar port:
// start registers a bundle on the host, chunk streams it out in
// WIRE_CHUNK_BYTES pieces, abort cleans up a receiver that gave up. Every
// transfer verb (refTips through bundleAbort) is {remote:true,
// mutating:true}, so that whole surface rides the per-peer command
// grant -- and the LAN wire, read-only by policy, refuses it outright.
// The transfer verbs also set movesHostState:false: serving a transfer
// moves no state a remote viewer caches, and without the opt-out every
// chunk resolution of a multi-minute pull would fire the registrar's
// cache ping (git:externalChange to every viewing peer). captureDirty
// is the exception and KEEPS the ping -- it writes a capture ref, real
// host state.
// Responses to awaited invokes are reliable on the device wire (pushes
// are droppable), which is why the transfer is invoke/response only.
//
// pullWorktree (slice C) is the odd one out: it is the LOCAL
// orchestrator a device's own renderer invokes to pull a peer's
// worktree here, driving the remote verbs above against that peer.
// Tagged {remote:false}, so it is never registered on any remote wire
// (main/ipc/register.ts only forwards remote:true) and the web
// loopback refuses it as a mutation. transplantWorktree (step 9) is
// the same local orchestrator shape: the pull plus tearing the source
// worktree down on the peer afterwards, where the teardown runs only
// when nothing can be lost (the dirty state landed here, or there was
// none) and rides the peer's ordinary grant-gated worktrees:delete.

// The refs a peer may request into a bundle, fail-closed: a branch
// (refs/heads/<name>) or a dirty-state capture
// (refs/shigomori/dirty/<worktreeId>, see cli/cmd_dirty.go). The
// charset is deliberately conservative -- these strings cross the
// device boundary into git argv on the host. This gate and the CLI's
// (bundleRefRe in cli/cmd_bundle.go) are deliberately DIFFERENT, not a
// mirror: this one pins the exact namespaces but still admits a
// trailing "/" or ".lock", while the CLI admits any refs/* yet bans
// those tails. Two complementary sieves, defense in depth -- their
// intersection is fail-closed, so nothing that clears both is exotic.
const BUNDLE_REF_RE =
  /^refs\/(heads\/[A-Za-z0-9][A-Za-z0-9._/-]*|shigomori\/dirty\/[0-9a-f]{12})$/;

export const SyncBundleRefSchema = z
  .string()
  .regex(BUNDLE_REF_RE, { message: "Ref outside the sync allowlist" })
  .refine((ref) => !ref.includes("..") && !ref.includes("//"), {
    message: "Ref outside the sync allowlist",
  });

// transferIds are host-minted (shared/ipc/hexId.ts pins the shape), so
// a peer can only replay an id it was given, never probe with crafted
// ones.
const TransferIdSchema = HexId32Schema;

export const SyncRefTipSchema = z.strictObject({
  ref: SyncBundleRefSchema,
  commit: CommitHashSchema,
});
export type SyncRefTip = z.infer<typeof SyncRefTipSchema>;

export const SyncCaptureDirtyPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: z.string().regex(/^[0-9a-f]{12}$/),
});

// Tip negotiation for the pull orchestration. Load bearing for
// thinness AND correctness: `git bundle create` silently DROPS a
// requested ref whose tip is already covered by a have (and refuses an
// all-covered bundle outright), so the receiver must learn the tip
// first and only request the branch when it lacks that commit.
export const SyncRefTipsPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  refs: z.array(SyncBundleRefSchema).min(1).max(64),
});

export const SyncRefTipsResultSchema = z.strictObject({
  // Requested refs that exist on the host, with their tips. A missing
  // ref is simply absent, not an error: the caller decides what a gone
  // branch means.
  tips: z.array(SyncRefTipSchema),
});

export const SyncBundleStartPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  refs: z.array(SyncBundleRefSchema).min(1).max(64),
  // Tips the receiver already holds, thinning the bundle. Hex-pinned
  // like every hash that travels toward git argv.
  haves: z.array(CommitHashSchema).max(256),
});

export const SyncBundleChunkPayloadSchema = z.strictObject({
  transferId: TransferIdSchema,
  offset: z.number().int().nonnegative(),
});

export const SyncBundleAbortPayloadSchema = z.strictObject({
  transferId: TransferIdSchema,
});

export const SyncCaptureDirtyResultSchema = z.strictObject({
  captured: z.boolean(),
  commit: CommitHashSchema.optional(),
});
export type SyncCaptureDirtyResult = z.infer<
  typeof SyncCaptureDirtyResultSchema
>;

export const SyncBundleStartResultSchema = z.strictObject({
  transferId: TransferIdSchema,
  bytes: z.number().int().nonnegative(),
});
export type SyncBundleStartResult = z.infer<typeof SyncBundleStartResultSchema>;

export const SyncBundleChunkResultSchema = z.strictObject({
  dataB64: ChunkB64Schema,
  eof: z.boolean(),
});

// The local pull orchestration's input: which peer, which of ITS
// project/worktree ids, and the branch to land here. sourceIdentity is
// the repo identity the renderer matched a local project on; the
// handler recomputes the local side and refuses on mismatch, so the
// call structurally cannot be aimed at a non-matching local repo. The
// branch refine pins it to the bundle allowlist up front, so a name
// the transfer surface would reject fails here with a clear message
// instead of deep inside the peer's schema.
export const SyncPullWorktreePayloadSchema = z.strictObject({
  sourceDeviceId: DeviceIdSchema,
  sourceProjectId: z.string().min(1),
  sourceWorktreeId: z.string().regex(/^[0-9a-f]{12}$/),
  sourceIdentity: z.string().min(1),
  branch: GitRefNameSchema.refine(
    (name) => SyncBundleRefSchema.safeParse(`refs/heads/${name}`).success,
    { message: "Branch name outside the sync allowlist" },
  ),
});

export const SyncPullWorktreeResultSchema = z.strictObject({
  worktree: WorktreeSchema,
  // captured && !dirtyApplied is the partial-success case: the source
  // had uncommitted changes, the worktree landed, but the apply was
  // refused. The capture stays parked under the local worktree id and
  // the source still holds the original dirty state.
  captured: z.boolean(),
  dirtyApplied: z.boolean(),
});
export type SyncPullWorktreeResult = z.infer<
  typeof SyncPullWorktreeResultSchema
>;

// The pull result plus the teardown's fate. A refused or failed
// teardown never fails the call: by then the pull succeeded and the
// state is safe on both sides, so the caller learns via
// sourceRemoved:false with sourceError carrying the stable marker or
// message ("scripts-running", a cleanup-script failure, a dirty state
// that did not land here).
export const SyncTransplantWorktreeResultSchema =
  SyncPullWorktreeResultSchema.extend({
    sourceRemoved: z.boolean(),
    sourceError: z.string().optional(),
  });
export type SyncTransplantWorktreeResult = z.infer<
  typeof SyncTransplantWorktreeResultSchema
>;

export const syncContract = defineContract("host", {
  refTips: invoke(
    "sync:refTips",
    SyncRefTipsPayloadSchema,
    SyncRefTipsResultSchema,
    // A read, but it discloses repo state, so it rides the command
    // grant with the rest of the transfer surface.
    { remote: true, mutating: true, movesHostState: false },
  ),
  // Writes a capture ref, so unlike the transfer verbs around it this
  // one KEEPS the viewer cache ping (no movesHostState opt-out).
  captureDirty: invoke(
    "sync:captureDirty",
    SyncCaptureDirtyPayloadSchema,
    SyncCaptureDirtyResultSchema,
    { remote: true, mutating: true },
  ),
  bundleStart: invoke(
    "sync:bundleStart",
    SyncBundleStartPayloadSchema,
    SyncBundleStartResultSchema,
    { remote: true, mutating: true, movesHostState: false },
  ),
  bundleChunk: invoke(
    "sync:bundleChunk",
    SyncBundleChunkPayloadSchema,
    SyncBundleChunkResultSchema,
    // Reads a host temp file, but it rides the command grant with the
    // rest of the transfer surface: chunk data is repo content.
    { remote: true, mutating: true, movesHostState: false },
  ),
  bundleAbort: invoke(
    "sync:bundleAbort",
    SyncBundleAbortPayloadSchema,
    z.void(),
    { remote: true, mutating: true, movesHostState: false },
  ),
  // The local orchestrator (see the header note): remote:false keeps
  // it off every remote wire, mutating:true documents intent and keeps
  // the web loopback's fail-closed refusal.
  pullWorktree: invoke(
    "sync:pullWorktree",
    SyncPullWorktreePayloadSchema,
    SyncPullWorktreeResultSchema,
    { remote: false, mutating: true },
  ),
  // Pull plus source teardown (see the header note). Same payload as
  // pullWorktree: the teardown targets exactly the source worktree the
  // pull captured from.
  transplantWorktree: invoke(
    "sync:transplantWorktree",
    SyncPullWorktreePayloadSchema,
    SyncTransplantWorktreeResultSchema,
    { remote: false, mutating: true },
  ),
});
