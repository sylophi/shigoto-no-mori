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
// whatever the switch says, and whether this device shares with its
// peers at all. The device link's gates consult it (host/socket/DeviceLink.ts
// isInvited and seesPush), and nothing else reads it.
//
// An invitation is pending from the ask until the peer's landing
// answers (it admits only that landing: of the original it names, into
// the repo and the clone place the ask named), then landed on the copy
// (it admits the calls scoped to that copy or its project) until the
// copy is gone: the stop's delete, a local delete, or the peer leaving
// the account (host/mirror/registry.ts, where the mirrors' own
// lifecycle hooks carry the invitations along), or a copy found
// missing at boot (loadMirrorInvites). Landed invitations persist in
// the store (the engine's MirrorInvites), so a relaunch still serves
// the mirrors it asked for. Pending ones do not: an ask dies with the
// process that made it. The gates read them synchronously, so they are
// held here too, read from the store as the mirror layer comes up and
// written back as they change.
//
// The v3 migration moved every worktree into wt/, and a worktree's id is
// a hash of its path, so a copy that landed before it has a new id while
// the peer running its mirror still names the old one. The invitations
// are re-keyed to the new ids as they load, and as a move or a rename
// here lands, and admit a call naming an old id as the copy it became
// (WtFolder.movedIds).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { allContractModules } from "@shigomori/contracts/allModules";
import {
  annotation,
  callsOf,
  channelOf,
  Invitable,
  type InvitableScope,
} from "@shigomori/contracts/contract";
import {
  type MirrorInvite,
  type MirrorInviteAsk,
  type MirrorWorktreePayload,
} from "@shigomori/contracts/modules/mirror";
import * as MirrorInvites from "@shigomori/engine/MirrorInvites";
import * as WtFolder from "@shigomori/engine/WtFolder";
import { SyncCloneIntoSchema } from "@shigomori/contracts/modules/sync";
import {
  ProjectScopedPayloadSchema,
  WorktreeIdSchema,
  WorktreeScopedPayloadSchema,
} from "@shigomori/contracts/schemas";

type Landed = MirrorInvite & { copy: MirrorWorktreePayload };

let invites: Types.Mutable<MirrorInvite>[] = [];
// The old id of each worktree a move took to a new one, to the new.
let movedIds: ReadonlyMap<string, string> = new Map();

// Whether `worktreeId`, as a peer names it, is the copy `copy`.
const namesCopy = (copy: MirrorWorktreePayload, worktreeId: string) =>
  copy.worktreeId === worktreeId ||
  copy.worktreeId === movedIds.get(worktreeId);

function isLanded(invite: MirrorInvite): invite is Landed {
  return invite.copy !== undefined;
}

// The landed ones, to the store as they stand when it runs. One that
// fails to write is logged: it may not fail the landing it follows.
const persist = Effect.flatMap(MirrorInvites.MirrorInvites, (store) =>
  Effect.suspend(() => store.save(invites.filter(isLanded))),
).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("[mirror] the invitations could not be saved", cause),
  ),
);

// Keeps the invitations `keep` answers true for, saving when any went.
const keepInvites = (keep: (invite: MirrorInvite) => boolean) =>
  Effect.suspend(() => {
    const kept = invites.filter(keep);
    if (kept.length === invites.length) return Effect.void;
    invites = kept;
    return persist;
  });

export function listMirrorInvites(): MirrorInvite[] {
  return structuredClone(invites);
}

// The ask: the peer may land this one worktree of its here. `withdraw`
// undoes it, pending or landed: the ask failed, and whatever the
// peer's rollback removed under it is gone.
export function inviteMirror(ask: MirrorInviteAsk): {
  withdraw: Effect.Effect<void, never, MirrorInvites.MirrorInvites>;
} {
  const invite: Types.Mutable<MirrorInvite> = { ...ask };
  invites.push(invite);
  return { withdraw: keepInvites((other) => other !== invite) };
}

// The landing answered: the pending invitation for this original
// becomes the copy's. Called by the landing itself (sync's
// receiveWorktree), before the peer's next call names the copy. A
// landing nobody here asked for (a plain send under the switch)
// matches nothing and leaves nothing behind.
export const landInvitedMirror = (
  peerDeviceId: string | undefined,
  sourceWorktreeId: string,
  copy: MirrorWorktreePayload,
) =>
  Effect.suspend(() => {
    const pending = invites.find(
      (invite) =>
        !isLanded(invite) &&
        invite.peerDeviceId === peerDeviceId &&
        invite.sourceWorktreeId === sourceWorktreeId,
    );
    if (pending === undefined) return Effect.void;
    pending.copy = { ...copy };
    return persist;
  });

// The copy is gone (the stop's delete, or any other), and with it the
// invitation.
export const forgetMirrorInvitesOf = (worktreeId: string) =>
  keepInvites(
    (invite) =>
      invite.copy === undefined || !namesCopy(invite.copy, worktreeId),
  );

// A worktree here moved while the app runs (a move, a rename): the
// invitation of a copy it was follows it, and the peer's calls by the
// id it had still name it.
export const moveMirrorInvitesOf = (fromId: string, toId: string) =>
  Effect.suspend(() => {
    const ids = new Map(
      [...movedIds].map(([old, now]) => [old, now === fromId ? toId : now]),
    );
    ids.set(fromId, toId);
    ids.delete(toId);
    movedIds = ids;
    let moved = false;
    for (const invite of invites) {
      if (invite.copy?.worktreeId !== fromId) continue;
      invite.copy = { ...invite.copy, worktreeId: toId };
      moved = true;
    }
    return moved ? persist : Effect.void;
  });

// The peers this device no longer shares an account with lose their
// invitations, like their mirrors.
export const dropMirrorInvitesWithPeers = (
  stillOnAccount: (deviceId: string) => boolean,
) => keepInvites((invite) => stillOnAccount(invite.peerDeviceId));

// The landed invitations as the store has them, read as the mirror
// layer comes up, in place of whatever is held, each copy under the id
// it has now. A store that fails to read starts empty: the mirrors it
// named can be asked for again.
export const loadMirrorInvites = Effect.gen(function* () {
  movedIds = yield* Effect.flatMap(
    WtFolder.WtFolder,
    (folder) => folder.movedIds,
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "[mirror] the moved worktrees could not be read",
        cause,
      ).pipe(Effect.as(new Map<string, string>())),
    ),
  );
  const loaded: ReadonlyArray<MirrorInvite> = yield* Effect.flatMap(
    MirrorInvites.MirrorInvites,
    (store) => store.load,
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "[mirror] the invitations could not be read, starting with none",
        cause,
      ).pipe(Effect.as([])),
    ),
  );
  let rekeyed = false;
  invites = loaded.filter(isLanded).map((invite): Landed => {
    const now = movedIds.get(invite.copy.worktreeId);
    if (now === undefined) return structuredClone(invite);
    rekeyed = true;
    return structuredClone({
      ...invite,
      copy: { ...invite.copy, worktreeId: now },
    });
  });
  if (rekeyed) yield* persist;
});

// A copy removed while the app was not running (a folder deleted by
// hand, a repo re-cloned) never passed the delete that forgets its
// invitation, and a worktree id is a path hash a later worktree can
// take. So the landed invitations are checked against the worktrees
// this device lists, once they are loaded. `exists` answers false only
// for a copy known to be gone: a lookup that failed for another reason
// must answer true, or a bad moment at boot would drop every mirror
// this device asked for.
export const reconcileMirrorInvites = <R>(
  exists: (copy: MirrorWorktreePayload) => Effect.Effect<boolean, never, R>,
) =>
  Effect.gen(function* () {
    const missing = new Set<MirrorInvite>();
    yield* Effect.forEach(
      invites.filter(isLanded),
      (invite) =>
        Effect.map(exists(invite.copy), (there) => {
          if (!there) missing.add(invite);
        }),
      { concurrency: "unbounded", discard: true },
    );
    yield* keepInvites((invite) => !missing.has(invite));
  });

// What an invitation admits, by the scope the call's contract entry
// declares (its Invitable annotation). The input is the raw frame's, read
// through the shared scoping schemas, so a shape that does not parse
// admits nothing.
const invitable = new Map<string, InvitableScope>();
for (const module of allContractModules) {
  for (const call of callsOf(module)) {
    const scope = annotation(call, Invitable);
    if (scope !== undefined) invitable.set(channelOf(call), scope);
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

// The pushes a mirror into this device follows (git:projectChanged,
// mirror:gitChanged) while sharing is off: one naming the project of a
// copy the peer's landed invitation covers.
export function mirrorInviteSees(
  peerDeviceId: string,
  payload: unknown,
): boolean {
  return (
    Schema.is(ProjectScopedPayloadSchema)(payload) &&
    invites.some(
      (invite) =>
        invite.peerDeviceId === peerDeviceId &&
        isLanded(invite) &&
        invite.copy.projectId === payload.projectId,
    )
  );
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
            namesCopy(invite.copy, input.worktreeId),
        )
      );
    }
  }
}
