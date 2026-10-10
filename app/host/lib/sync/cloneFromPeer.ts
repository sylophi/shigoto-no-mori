// A checkout of a repo made on this device from another device's copy,
// over the device link: a landing's project when this device has none
// (a pull's `cloneInto`, or a send's, where the landing runs here on
// the source's behalf). The source's default branch crosses as a
// bundle on the same source link the branch itself then does
// (sourceLink.ts), so a repo with no remote gets here too, and the
// link's grant is the one gate. The bundle unpacks into a fresh
// repository at the folder asked for, the branch is checked out, the
// source's remote is set up when it has one, and the checkout is
// registered the way the add-project dialog's clone is (`sm projects
// add`, config seed included, which is why the register waits for the
// checkout). Up to the register everything is undone on failure: the
// folder is this call's own, made here.
import { isCloneableRemote } from "@shigomori/contracts/predicates/remoteUrl";
import { mkdir, rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  SyncBundleRefSchema,
  type SyncCloneInto,
} from "@shigomori/contracts/modules/sync";
import { checkNewCheckoutDestination } from "@host/lib/git/clone";
import { GitRefusal, run } from "@host/lib/git/core";
import { deleteRef, updateRef } from "@host/lib/git/refs";
import { expandHome } from "@host/lib/util/paths";
import { incomingRefFor, type WorktreeSource } from "./sourceLink";

const decodeBundleRef = Schema.decodeSync(SyncBundleRefSchema);

// An interrupt (the move's cancel) undoes the folder like any failure.
// During the fetch the link's reset does the failing. Answers the
// checkout, which the caller registers.
export const cloneCheckoutFromPeer = Effect.fnUntraced(function* (
  source: WorktreeSource,
  { parentDir, name }: SyncCloneInto,
  // The branch the landing puts its copy on afterwards: the clone's own
  // branch cannot be it, and that is known before a byte moves.
  landing: string,
  onProgress?: (bytes: number, totalBytes: number) => void,
) {
  // The source's default branch is what the checkout is made of, so the
  // clone reads as the repo (its identity is the root of that branch,
  // packages/engine/src/Identity.ts) and not as one worktree of it. The
  // remote it was cloned from comes along when it has one, so the
  // clone is what a clone of that remote would be, and reads as the
  // same repo even when its default branch is only the remote's HEAD
  // to go by. Both re-parsed by the link: they flow into refs and argv
  // here. The parent is made if need be: the dialog's default is the
  // source's own layout, which this machine may not have yet. A parent
  // that cannot be made (a file in its place) is the destination
  // check's to name.
  const parent = expandHome(parentDir);
  yield* Effect.promise(() =>
    mkdir(parent, { recursive: true }).catch(() => {}),
  );
  const [dest, { branch, remoteUrl }] = yield* Effect.all(
    [checkNewCheckoutDestination(parent, name), source.cloneFacts],
    { concurrency: 2 },
  );
  if (
    landing === branch ||
    landing.startsWith(`${branch}/`) ||
    branch.startsWith(`${landing}/`)
  ) {
    return yield* new GitRefusal({
      reason: `The copy would land on ${landing}, which the clone here checks out as the repo's default branch. Bring a worktree on another branch, or mirror the primary checkout.`,
    });
  }
  const branchRef = decodeBundleRef(`refs/heads/${branch}`);
  const incomingRef = incomingRefFor(branch);

  yield* Effect.promise(() => mkdir(dest));
  yield* Effect.gen(function* () {
    yield* run(dest, ["init", "--quiet"]);
    // HEAD names the branch before it exists, so the checkout below is
    // one reset, and a clone of a repo whose default branch is not
    // git's own default lands on the right one.
    yield* run(dest, ["symbolic-ref", "HEAD", branchRef]);
    const { fetched } = yield* source.fetch({
      refs: [branchRef],
      haves: [],
      into: { path: dest },
      onProgress,
    });
    const tip = fetched.find((entry) => entry.ref === incomingRef)?.commit;
    if (tip === undefined) {
      return yield* new GitRefusal({
        reason: `${branch} did not arrive whole from the other device.`,
      });
    }
    yield* updateRef(dest, branchRef, tip);
    yield* deleteRef(dest, incomingRef);
    yield* run(dest, ["reset", "--quiet", "--hard"]);
    // The remote as `git clone` would leave it: origin, its HEAD on the
    // branch, the branch tracking it. The source answered the URL with
    // the clone payload's own rule (shared/cloneUrl.ts), re-checked
    // here before it reaches argv.
    if (remoteUrl !== null && isCloneableRemote(remoteUrl)) {
      yield* run(dest, ["remote", "add", "origin", remoteUrl]);
      yield* updateRef(dest, `refs/remotes/origin/${branch}`, tip);
      yield* run(dest, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${branch}`,
      ]);
      yield* run(dest, [
        "branch",
        "--set-upstream-to",
        `origin/${branch}`,
        "--end-of-options",
        branch,
      ]);
    }
  }).pipe(
    Effect.onError(() =>
      Effect.promise(() =>
        rm(dest, { recursive: true, force: true }).catch(() => {}),
      ),
    ),
  );
  return dest;
});
