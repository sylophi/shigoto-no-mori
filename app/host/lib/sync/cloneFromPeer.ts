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
import { mkdir, rm } from "node:fs/promises";
import { isCloneableRemote } from "@shared/cloneUrl";
import { errorMessageOf } from "@shared/errors";
import {
  type SyncCloneInto,
  SyncBundleRefSchema,
} from "@shared/ipc/modules/sync";
import type { Project } from "@shared/schemas";
import { checkCloneDestination } from "@host/lib/git/clone";
import { run } from "@host/lib/git/core";
import { deleteRef, updateRef } from "@host/lib/git/refs";
import { registerProject } from "@host/lib/projects";
import { expandHome } from "@host/lib/util/paths";
import { incomingRefFor, type WorktreeSource } from "./sourceLink";

export async function cloneProjectFromPeer(
  source: WorktreeSource,
  { parentDir, name }: SyncCloneInto,
  // The branch the landing puts its copy on afterwards: the clone's own
  // branch cannot be it, and that is known before a byte moves.
  landing: string,
  onProgress?: (bytes: number, totalBytes: number) => void,
): Promise<Project> {
  // The source's default branch is what the checkout is made of, so the
  // clone reads as the repo (its identity is the root of that branch,
  // shared/git/repoIdentity.mts) and not as one worktree of it. The
  // remote it was cloned from comes along when it has one, so the
  // clone is what a clone of that remote would be, and reads as the
  // same repo even when its default branch is only the remote's HEAD
  // to go by. Both re-parsed by the link: they flow into refs and argv
  // here. The parent is made if need be: the dialog's default is the
  // source's own layout, which this machine may not have yet. A parent
  // that cannot be made (a file in its place) is the destination
  // check's to name.
  const parent = expandHome(parentDir);
  await mkdir(parent, { recursive: true }).catch(() => {});
  const [dest, { branch, remoteUrl }] = await Promise.all([
    checkCloneDestination(parent, name),
    source.cloneFacts(),
  ]);
  if (
    landing === branch ||
    landing.startsWith(`${branch}/`) ||
    branch.startsWith(`${landing}/`)
  ) {
    throw new Error(
      `The copy would land on ${landing}, which the clone here checks out as the repo's default branch. Bring a worktree on another branch, or mirror the primary checkout.`,
    );
  }
  const branchRef = SyncBundleRefSchema.parse(`refs/heads/${branch}`);
  const incomingRef = incomingRefFor(branch);

  await mkdir(dest);
  try {
    await run(dest, ["init", "--quiet"]);
    // HEAD names the branch before it exists, so the checkout below is
    // one reset, and a clone of a repo whose default branch is not
    // git's own default lands on the right one.
    await run(dest, ["symbolic-ref", "HEAD", branchRef]);
    const { fetched } = await source.fetch({
      refs: [branchRef],
      haves: [],
      into: { path: dest },
      onProgress,
    });
    const tip = fetched.find((entry) => entry.ref === incomingRef)?.commit;
    if (tip === undefined) {
      throw new Error(`${branch} did not arrive whole from the other device.`);
    }
    await updateRef(dest, branchRef, tip);
    await deleteRef(dest, incomingRef);
    await run(dest, ["reset", "--quiet", "--hard"]);
    // The remote as `git clone` would leave it: origin, its HEAD on the
    // branch, the branch tracking it. The source answered the URL with
    // the clone payload's own rule (shared/cloneUrl.ts), re-checked
    // here before it reaches argv.
    if (remoteUrl !== null && isCloneableRemote(remoteUrl)) {
      await run(dest, ["remote", "add", "origin", remoteUrl]);
      await updateRef(dest, `refs/remotes/origin/${branch}`, tip);
      await run(dest, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${branch}`,
      ]);
      await run(dest, [
        "branch",
        "--set-upstream-to",
        `origin/${branch}`,
        "--end-of-options",
        branch,
      ]);
    }
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // The checkout stays if registering fails, so the error says where
  // it is: a retry would only find the folder taken.
  return registerProject(dest).catch((error: unknown) => {
    throw new Error(
      `Cloned into ${dest}, but couldn't add it as a project: ${errorMessageOf(error)}`,
    );
  });
}
