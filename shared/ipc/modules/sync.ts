import { z } from "zod";
import { defineContract, invoke } from "@shared/ipc/contract";
import { CommitHashSchema } from "@shared/schemas";

// Device-sync transfer plumbing (v2 step 7, slice B): git bundles move
// between devices as chunked, grant-gated invoke responses over the
// existing device connection. No new wire protocol, no sidecar port:
// start registers a bundle on the host, chunk streams it out in
// relay-sized pieces, abort cleans up a receiver that gave up. Every
// call is {remote:true, mutating:true}, so the whole surface rides the
// per-peer command grant -- and the LAN wire, read-only by policy,
// refuses it outright. Responses to awaited invokes are reliable on
// the relay link (pushes are droppable), which is why the transfer is
// invoke/response only.

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

// transferIds are host-minted (16 random bytes, hex), so the schema
// pins exactly that shape: a peer can only replay an id it was given,
// never probe with crafted ones.
const TransferIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

export const SyncRefTipSchema = z.strictObject({
  ref: SyncBundleRefSchema,
  commit: CommitHashSchema,
});
export type SyncRefTip = z.infer<typeof SyncRefTipSchema>;

export const SyncCaptureDirtyPayloadSchema = z.strictObject({
  projectId: z.string().min(1),
  worktreeId: z.string().regex(/^[0-9a-f]{12}$/),
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
  refs: z.array(SyncRefTipSchema),
});
export type SyncBundleStartResult = z.infer<typeof SyncBundleStartResultSchema>;

export const SyncBundleChunkResultSchema = z.strictObject({
  dataB64: z.string(),
  eof: z.boolean(),
});

export const syncContract = defineContract("host", {
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
    { remote: true, mutating: true },
  ),
  bundleChunk: invoke(
    "sync:bundleChunk",
    SyncBundleChunkPayloadSchema,
    SyncBundleChunkResultSchema,
    // Reads a host temp file, but it rides the command grant with the
    // rest of the transfer surface: chunk data is repo content.
    { remote: true, mutating: true },
  ),
  bundleAbort: invoke(
    "sync:bundleAbort",
    SyncBundleAbortPayloadSchema,
    z.void(),
    {
      remote: true,
      mutating: true,
    },
  ),
});
