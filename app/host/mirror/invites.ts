// The mirrors this device asked for. A mirror runs on the device
// holding the original (host/ipc/modules/mirror.ts), so "Mirror here"
// and `sm worktrees mirror --from` ask a peer to run one INTO this
// device: the peer's send lands the copy here, its session streams
// files into it, its git follower reads and applies the copy's git
// state and fetches and pushes its commits, and its stop removes the
// copy. Every one of those is a gated call on this host, and the
// command-access switch says whether peers may run gated calls here
// unasked. A mirror this device asked for is not unasked, so the ask
// leaves an invitation behind: the one peer may run exactly the calls
// a mirror into this device makes (the contracts tag them `invitable`,
// packages/contracts/src/contract.ts), on the one worktree the mirror landed,
// whatever the switch says. The direct listener's gate consults it
// (host/socket/server.ts isInvited), and nothing else reads it.
//
// An invitation is pending from the ask until the peer's landing
// answers (it admits only that landing: of the original it names, into
// the repo and the clone place the ask named), then landed on the copy
// (it admits the calls scoped to that copy or its project) until the
// copy is gone: the stop's delete, a local delete, or the peer leaving
// the account (host/mirror/registry.ts, where the mirrors' own
// lifecycle hooks carry the invitations along), or a copy found
// missing at boot (reconcileMirrorInvites). Landed invitations persist
// beside the follower's store, so a relaunch still serves the mirrors
// it asked for. Pending ones do not: an ask dies with the process that
// made it.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { DeviceIdSchema } from "@shigomori/contracts/hubProtocol";
import { allContractModules } from "@shared/ipc/client";
import type { InvitableScope } from "@shigomori/contracts/contract";
import {
  type MirrorWorktreePayload,
  MirrorWorktreePayloadSchema,
} from "@shigomori/contracts/modules/mirror";
import { SyncCloneIntoSchema } from "@shigomori/contracts/modules/sync";
import {
  ProjectScopedPayloadSchema,
  WorktreeIdSchema,
  WorktreeScopedPayloadSchema,
} from "@shigomori/contracts/schemas";
import { strict } from "@shigomori/contracts/schemas/strict";

// What the ask named, which the landing must match.
const MirrorInviteAskSchema = strict(
  Schema.Struct({
    peerDeviceId: DeviceIdSchema,
    // The peer's original, the id its landing names.
    sourceWorktreeId: WorktreeIdSchema,
    // The repo it belongs to, and where the copy lands when this device
    // has no checkout of it.
    identity: Schema.NonEmptyString,
    cloneInto: Schema.optional(SyncCloneIntoSchema),
  }),
);
export type MirrorInviteAsk = typeof MirrorInviteAskSchema.Type;

export const MirrorInviteSchema = strict(
  Schema.Struct({
    ...MirrorInviteAskSchema.struct.fields,
    // The copy here, once the landing answered. Absent while pending.
    copy: Schema.optional(MirrorWorktreePayloadSchema),
  }),
);
export type MirrorInvite = typeof MirrorInviteSchema.Type;
type Landed = MirrorInvite & { copy: MirrorWorktreePayload };

// Where the landed invitations live, wired by main beside the
// follower's store. A store that fails to read starts empty (the
// mirrors it named can be asked for again) and one that fails to
// write is logged: neither may fail the landing or the boot. Unwired
// (a check, a surface without the daemon), nothing persists and
// nothing is admitted past the switch.
export type MirrorInviteStore = {
  load: () => readonly MirrorInvite[];
  save: (invites: MirrorInvite[]) => void;
};

let store: MirrorInviteStore | null = null;
let invites: Types.Mutable<MirrorInvite>[] = [];

export function setMirrorInviteStore(next: MirrorInviteStore | null): void {
  store = next;
  invites = [];
  if (next === null) return;
  try {
    invites = next.load().filter(isLanded);
  } catch (error) {
    console.warn(
      `[mirror] the invitations could not be read, starting with none: ${errorMessageOf(error)}`,
    );
  }
}

function isLanded(invite: MirrorInvite): invite is Landed {
  return invite.copy !== undefined;
}

function persist(): void {
  try {
    store?.save(invites.filter(isLanded));
  } catch (error) {
    console.warn(
      `[mirror] the invitations could not be saved: ${errorMessageOf(error)}`,
    );
  }
}

// Keeps the invitations `keep` answers true for, saving when any went.
function keepInvites(keep: (invite: MirrorInvite) => boolean): void {
  const kept = invites.filter(keep);
  if (kept.length === invites.length) return;
  invites = kept;
  persist();
}

export function listMirrorInvites(): MirrorInvite[] {
  return structuredClone(invites);
}

// The ask: the peer may land this one worktree of its here. `withdraw`
// undoes it, pending or landed: the ask failed, and whatever the
// peer's rollback removed under it is gone.
export function inviteMirror(ask: MirrorInviteAsk): { withdraw: () => void } {
  const invite: Types.Mutable<MirrorInvite> = { ...ask };
  invites.push(invite);
  return { withdraw: () => keepInvites((other) => other !== invite) };
}

// The landing answered: the pending invitation for this original
// becomes the copy's. Called by the landing itself (sync's
// receiveWorktree), before the peer's next call names the copy. A
// landing nobody here asked for (a plain send under the switch)
// matches nothing and leaves nothing behind.
export function landInvitedMirror(
  peerDeviceId: string | undefined,
  sourceWorktreeId: string,
  copy: MirrorWorktreePayload,
): void {
  const pending = invites.find(
    (invite) =>
      !isLanded(invite) &&
      invite.peerDeviceId === peerDeviceId &&
      invite.sourceWorktreeId === sourceWorktreeId,
  );
  if (pending === undefined) return;
  pending.copy = { ...copy };
  persist();
}

// The copy is gone (the stop's delete, or any other), and with it the
// invitation.
export function forgetMirrorInvitesOf(worktreeId: string): void {
  keepInvites((invite) => invite.copy?.worktreeId !== worktreeId);
}

// The peers this device no longer shares an account with lose their
// invitations, like their mirrors.
export function dropMirrorInvitesWithPeers(
  stillOnAccount: (deviceId: string) => boolean,
): void {
  keepInvites((invite) => stillOnAccount(invite.peerDeviceId));
}

// A copy removed while the app was not running (a folder deleted by
// hand, a repo re-cloned) never passed the delete that forgets its
// invitation, and a worktree id is a path hash a later worktree can
// take. So the landed invitations are checked against the worktrees
// this device lists, once the store is loaded. `exists` answers false
// only for a copy known to be gone: a lookup that failed for another
// reason must answer true, or a bad moment at boot would drop every
// mirror this device asked for.
export async function reconcileMirrorInvites(
  exists: (copy: MirrorWorktreePayload) => Promise<boolean>,
): Promise<void> {
  const missing = new Set<MirrorInvite>();
  await Promise.all(
    invites.filter(isLanded).map(async (invite) => {
      if (!(await exists(invite.copy))) missing.add(invite);
    }),
  );
  keepInvites((invite) => !missing.has(invite));
}

// What an invitation admits, by the scope the call's contract entry
// declares (InvokeDef.invitable). The input is the raw frame's, read
// through the shared scoping schemas, so a shape that does not parse
// admits nothing.
const invitable = new Map<string, InvitableScope>();
for (const module of allContractModules) {
  for (const def of Object.values(module.calls)) {
    if (def.kind === "invoke" && def.invitable !== undefined) {
      invitable.set(def.channel, def.invitable);
    }
  }
}
export const invitableChannels = (): ReadonlyMap<string, InvitableScope> =>
  invitable;

const LandingScopeSchema = Schema.Struct({
  sourceWorktreeId: WorktreeIdSchema,
  identity: Schema.NonEmptyString,
  cloneInto: Schema.optional(SyncCloneIntoSchema),
});
const decodeLandingScope = Schema.decodeUnknownOption(LandingScopeSchema);

function sameCloneInto(
  a: MirrorInvite["cloneInto"],
  b: MirrorInvite["cloneInto"],
): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.parentDir === b.parentDir && a.name === b.name;
}

export function mirrorInviteAdmits(
  peerDeviceId: string,
  channel: string,
  input: unknown,
): boolean {
  const scope = invitable.get(channel);
  if (scope === undefined) return false;
  const mine = invites.filter((invite) => invite.peerDeviceId === peerDeviceId);
  if (mine.length === 0) return false;
  switch (scope) {
    case "landing": {
      const landing = decodeLandingScope(input);
      return (
        Option.isSome(landing) &&
        mine.some(
          (invite) =>
            !isLanded(invite) &&
            invite.sourceWorktreeId === landing.value.sourceWorktreeId &&
            invite.identity === landing.value.identity &&
            sameCloneInto(invite.cloneInto, landing.value.cloneInto),
        )
      );
    }
    case "project": {
      return (
        Schema.is(ProjectScopedPayloadSchema)(input) &&
        mine.some(
          (invite) =>
            isLanded(invite) && invite.copy.projectId === input.projectId,
        )
      );
    }
    case "copy": {
      return (
        Schema.is(WorktreeScopedPayloadSchema)(input) &&
        mine.some(
          (invite) =>
            isLanded(invite) &&
            invite.copy.projectId === input.projectId &&
            invite.copy.worktreeId === input.worktreeId,
        )
      );
    }
  }
}
