// Durable proof for the mirror invitations (host/mirror/invites.ts):
// what an ask admits past the command-access switch, and when. Drives
// the store's own surface against the gate predicate the direct
// listener consults, with the persistence seam a recording double.
// Asserts:
//   - the invited surface is exactly the calls a mirror into this
//     device makes, as the contracts tag them (invitable), pinned here
//     so a tag added or dropped is a reviewed change,
//   - nothing is admitted with no invitation,
//   - a pending invitation admits the peer's landing of the one
//     original it names into the repo and clone place the ask named,
//     and nothing else: not another original, repo or place, not
//     another peer, not the copy-scoped calls,
//   - landed, it admits the copy-scoped calls on that one copy and the
//     project-scoped ones in its project, and no longer a landing. A
//     landing nobody asked for lands nothing, and an input that does
//     not parse admits nothing,
//   - it is dropped with the copy, withdrawn by a failed ask, gone with
//     a peer that left the account, and gone when the boot finds the
//     copy missing,
//   - only landed invitations reach the store, a store loads back
//     admitting what it saved, and one that fails to read or write
//     never throws.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test mirror-invites.
import assert from "node:assert/strict";
import {
  dropMirrorInvitesWithPeers,
  forgetMirrorInvitesOf,
  invitableChannels,
  inviteMirror,
  landInvitedMirror,
  listMirrorInvites,
  type MirrorInvite,
  mirrorInviteAdmits,
  reconcileMirrorInvites,
  setMirrorInviteStore,
} from "@host/mirror/invites";
import { makeProof } from "./lib/checkKit.mts";

const { check, done, fail } = makeProof("mirror-invites proof");
console.log("mirror-invites proof\n");

const PEER = "peer-a";
const OTHER_PEER = "peer-c";
const ORIGINAL = "0123456789ab";
const OTHER_ORIGINAL = "ba9876543210";
const IDENTITY = "repo-identity";
const CLONE_INTO = { parentDir: "/Users/me/src", name: "shared" };
const ASK = {
  peerDeviceId: PEER,
  sourceWorktreeId: ORIGINAL,
  identity: IDENTITY,
};
const COPY = { projectId: "target", worktreeId: "abcdef012345" };
const OTHER_COPY = { projectId: "target", worktreeId: "543210fedcba" };
// A landing as the peer names it, for the invited original.
const LANDING_OF = (sourceWorktreeId: string) => ({
  sourceWorktreeId,
  identity: IDENTITY,
  branch: "feat",
  channelId: "0123456789abcdef0123456789abcdef",
});

const admits = (channel: string, input: unknown, peer = PEER) =>
  mirrorInviteAdmits(peer, channel, input);

// The calls a mirror into this device makes, by phase.
const LANDING = "sync:receiveWorktree";
const STREAM = "mirror:openStream";
const COPY_CALLS = [
  STREAM,
  "mirror:gitState",
  "mirror:applyGitState",
  "mirror:release",
  "sync:openSource",
  "worktrees:delete",
  "worktreeData:describe",
];
const PROJECT_CALLS = ["sync:receiveBundle", "sync:hasCommits"];

// A store whose disk says no, either way.
function brokenDisk(): never {
  throw new Error("disk says no");
}

// A store that records what is saved and answers with a seed.
function recordingStore(seed: MirrorInvite[] = []) {
  const saved: MirrorInvite[][] = [];
  return {
    saved,
    store: {
      load: () => seed,
      save: (invites: MirrorInvite[]) => {
        saved.push(structuredClone(invites));
      },
    },
  };
}

async function main() {
  await check("the invited surface is the contracts' invitable calls", () => {
    const surface = Object.fromEntries(
      [...invitableChannels()].toSorted(([a], [b]) => a.localeCompare(b)),
    );
    assert.deepEqual(surface, {
      [LANDING]: "landing",
      "mirror:applyGitState": "copy",
      "mirror:gitState": "copy",
      "mirror:openStream": "copy",
      "mirror:release": "copy",
      "sync:hasCommits": "project",
      "sync:openSource": "copy",
      "sync:receiveBundle": "project",
      "worktreeData:describe": "copy",
      "worktrees:delete": "copy",
    });
  });

  await check("nothing is admitted unasked", () => {
    setMirrorInviteStore(recordingStore().store);
    assert.equal(admits(LANDING, LANDING_OF(ORIGINAL)), false);
    for (const channel of [...COPY_CALLS, ...PROJECT_CALLS]) {
      assert.equal(admits(channel, COPY), false, channel);
    }
  });

  await check(
    "pending: the peer's landing of the named original into the named repo and place, and nothing else",
    () => {
      setMirrorInviteStore(recordingStore().store);
      const invite = inviteMirror(ASK);
      assert.equal(admits(LANDING, LANDING_OF(ORIGINAL)), true);
      assert.equal(
        admits(LANDING, LANDING_OF(OTHER_ORIGINAL)),
        false,
        "another original",
      );
      assert.equal(
        admits(LANDING, { ...LANDING_OF(ORIGINAL), identity: "other-repo" }),
        false,
        "another repo",
      );
      assert.equal(
        admits(LANDING, { ...LANDING_OF(ORIGINAL), cloneInto: CLONE_INTO }),
        false,
        "a clone place the ask never named",
      );
      assert.equal(
        admits(LANDING, LANDING_OF(ORIGINAL), OTHER_PEER),
        false,
        "another peer",
      );
      for (const channel of [...COPY_CALLS, ...PROJECT_CALLS]) {
        assert.equal(admits(channel, COPY), false, `${channel} before landing`);
      }
      assert.deepEqual(listMirrorInvites(), [ASK]);
      invite.withdraw();
      assert.deepEqual(listMirrorInvites(), [], "withdrawn with the ask");
      assert.equal(admits(LANDING, LANDING_OF(ORIGINAL)), false);
      // An ask that names a clone place is held to it.
      const placed = inviteMirror({ ...ASK, cloneInto: CLONE_INTO });
      assert.equal(admits(LANDING, LANDING_OF(ORIGINAL)), false, "no place");
      assert.equal(
        admits(LANDING, {
          ...LANDING_OF(ORIGINAL),
          cloneInto: { ...CLONE_INTO, name: "elsewhere" },
        }),
        false,
        "another place",
      );
      assert.equal(
        admits(LANDING, { ...LANDING_OF(ORIGINAL), cloneInto: CLONE_INTO }),
        true,
      );
      placed.withdraw();
    },
  );

  await check(
    "landed: the copy-scoped calls on that copy, the project-scoped ones in its project, and no landing any more",
    () => {
      const { store, saved } = recordingStore();
      setMirrorInviteStore(store);
      inviteMirror(ASK);
      // A landing nobody asked for (a plain send, under the switch)
      // lands nothing, nor does one on a wire that stamps no caller.
      landInvitedMirror(OTHER_PEER, ORIGINAL, OTHER_COPY);
      landInvitedMirror(PEER, OTHER_ORIGINAL, OTHER_COPY);
      landInvitedMirror(undefined, ORIGINAL, OTHER_COPY);
      assert.equal(saved.length, 0, "nothing landed, nothing saved");
      landInvitedMirror(PEER, ORIGINAL, COPY);
      for (const channel of COPY_CALLS) {
        assert.equal(admits(channel, COPY), true, channel);
        assert.equal(
          admits(channel, OTHER_COPY),
          false,
          `${channel} elsewhere`,
        );
        assert.equal(
          admits(channel, { ...COPY, projectId: "elsewhere" }),
          false,
          `${channel} in another project`,
        );
        assert.equal(
          admits(channel, COPY, OTHER_PEER),
          false,
          `${channel} by another peer`,
        );
        assert.equal(
          admits(channel, { worktreeId: COPY.worktreeId }),
          false,
          `${channel} with a payload that does not parse`,
        );
      }
      for (const channel of PROJECT_CALLS) {
        assert.equal(
          admits(channel, { projectId: COPY.projectId }),
          true,
          channel,
        );
        assert.equal(admits(channel, { projectId: "elsewhere" }), false);
        assert.equal(
          admits(channel, "target"),
          false,
          "a payload that is no object",
        );
      }
      assert.equal(
        admits(LANDING, LANDING_OF(ORIGINAL)),
        false,
        "the landing is done",
      );
      assert.equal(
        admits("worktrees:create", COPY),
        false,
        "an unrelated call",
      );
      assert.deepEqual(
        saved.at(-1),
        [{ ...ASK, copy: COPY }],
        "the landed invitation is saved",
      );
    },
  );

  await check(
    "ended: with the copy, by a failed ask, with a peer that left, and when the boot finds the copy missing",
    async () => {
      const { store, saved } = recordingStore();
      setMirrorInviteStore(store);
      // With the copy.
      inviteMirror(ASK);
      landInvitedMirror(PEER, ORIGINAL, COPY);
      forgetMirrorInvitesOf(OTHER_COPY.worktreeId);
      assert.equal(admits(STREAM, COPY), true, "another copy's removal");
      forgetMirrorInvitesOf(COPY.worktreeId);
      assert.equal(admits(STREAM, COPY), false);
      assert.deepEqual(saved.at(-1), [], "the removal is saved");
      // By a failed ask, after the landing: the peer's rollback
      // removed the copy under the invitation, then the ask failed.
      const failed = inviteMirror(ASK);
      landInvitedMirror(PEER, ORIGINAL, COPY);
      failed.withdraw();
      assert.equal(admits(STREAM, COPY), false);
      assert.deepEqual(listMirrorInvites(), []);
      failed.withdraw();
      assert.deepEqual(listMirrorInvites(), [], "a second withdraw is a no-op");
      // With a peer that left the account.
      inviteMirror(ASK);
      landInvitedMirror(PEER, ORIGINAL, COPY);
      inviteMirror({
        ...ASK,
        peerDeviceId: OTHER_PEER,
        sourceWorktreeId: OTHER_ORIGINAL,
      });
      landInvitedMirror(OTHER_PEER, OTHER_ORIGINAL, OTHER_COPY);
      dropMirrorInvitesWithPeers((deviceId) => deviceId === PEER);
      assert.equal(admits(STREAM, OTHER_COPY, OTHER_PEER), false);
      assert.equal(admits(STREAM, COPY), true, "the peer still on stays");
      // When the boot finds the copy missing: the landed one whose
      // worktree is gone goes, the other stays, a pending ask is not
      // asked about.
      inviteMirror({ ...ASK, sourceWorktreeId: OTHER_ORIGINAL });
      landInvitedMirror(PEER, OTHER_ORIGINAL, OTHER_COPY);
      const asked: string[] = [];
      await reconcileMirrorInvites(async ({ worktreeId }) => {
        asked.push(worktreeId);
        return worktreeId === COPY.worktreeId;
      });
      assert.deepEqual(
        asked.toSorted(),
        [COPY.worktreeId, OTHER_COPY.worktreeId].toSorted(),
      );
      assert.equal(admits(STREAM, COPY), true);
      assert.equal(
        admits(STREAM, OTHER_COPY),
        false,
        "the missing copy's went",
      );
      dropMirrorInvitesWithPeers(() => false);
      assert.deepEqual(listMirrorInvites(), []);
    },
  );

  await check(
    "the store: only landed invitations reach it, a load admits what it saved, and a broken store never throws",
    () => {
      const { store, saved } = recordingStore();
      setMirrorInviteStore(store);
      inviteMirror(ASK);
      inviteMirror({
        ...ASK,
        peerDeviceId: OTHER_PEER,
        sourceWorktreeId: OTHER_ORIGINAL,
      });
      landInvitedMirror(PEER, ORIGINAL, COPY);
      assert.equal(saved.length, 1);
      assert.deepEqual(
        saved[0]?.map((invite) => invite.peerDeviceId),
        [PEER],
        "the pending ask is not saved",
      );
      // A fresh process loads the file: the landed one is back, a
      // pending one that somehow got there is not.
      const stale: MirrorInvite = {
        ...ASK,
        peerDeviceId: OTHER_PEER,
        sourceWorktreeId: OTHER_ORIGINAL,
      };
      setMirrorInviteStore(recordingStore([...(saved[0] ?? []), stale]).store);
      assert.equal(admits(STREAM, COPY), true);
      assert.equal(
        admits("sync:receiveBundle", { projectId: COPY.projectId }),
        true,
      );
      assert.equal(
        admits(LANDING, LANDING_OF(OTHER_ORIGINAL), OTHER_PEER),
        false,
        "a pending ask does not survive the process",
      );
      // A store that cannot be read starts empty, and one that cannot
      // be written loses nothing in memory. Neither throws.
      setMirrorInviteStore({ load: brokenDisk, save: brokenDisk });
      assert.deepEqual(listMirrorInvites(), []);
      inviteMirror(ASK);
      landInvitedMirror(PEER, ORIGINAL, COPY);
      assert.equal(
        admits(STREAM, COPY),
        true,
        "landed despite the failed save",
      );
      setMirrorInviteStore(null);
      assert.equal(admits(STREAM, COPY), false, "unwired, nothing");
    },
  );

  done();
}

main().catch(fail);
