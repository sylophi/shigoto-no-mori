// A checkout of a peer's repo made on this device over the device
// link: the pull's landing project when this device has none
// (sync:pullWorktree's `cloneInto`). The peer's default branch crosses
// as a bundle, the way the pulled branch does, so a repo with no
// remote gets here too and the peer's grant is the one gate. The
// bundle unpacks into a fresh repository at the folder asked for, the
// branch is checked out, and the checkout is registered the way the
// add-project dialog's clone is (`sm projects add`, config seed
// included, which is why the register waits for the checkout). Up to
// the register everything is undone on failure: the folder is this
// call's own, made here.
import { mkdir, rm } from "node:fs/promises";
import { errorMessageOf } from "@shared/errors";
import {
  type SyncCloneInto,
  SyncBundleRefSchema,
} from "@shared/ipc/modules/sync";
import { GitRefNameSchema, type Project } from "@shared/schemas";
import { projectsAddViaCli } from "@host/ipc/cliDelegate";
import type { PeerProjectsApi, PeerSyncApi } from "@host/ipc/peerSync";
import { checkCloneDestination } from "@host/lib/git/clone";
import { run } from "@host/lib/git/core";
import { deleteRef, updateRef } from "@host/lib/git/refs";
import { expandHome } from "@host/lib/util/paths";
import { fetchBundleFromPeer, incomingRefFor } from "./fetchBundle";

export async function cloneProjectFromPeer(
  peer: { sync: PeerSyncApi; projects: PeerProjectsApi },
  sourceProjectId: string,
  { parentDir, name }: SyncCloneInto,
  onProgress?: (bytes: number, totalBytes: number) => void,
): Promise<Project> {
  // The peer's default branch is what the checkout is made of, so the
  // clone reads as the repo (its identity is the root of that branch,
  // shared/git/repoIdentity.mts) and not as one worktree of it.
  // Re-parsed: it flows into refs and argv here.
  const [dest, branch] = await Promise.all([
    checkCloneDestination(expandHome(parentDir), name),
    peer.projects
      .defaultBranch({ projectId: sourceProjectId })
      .then((answer) => GitRefNameSchema.parse(answer)),
  ]);
  const branchRef = SyncBundleRefSchema.parse(`refs/heads/${branch}`);
  const incomingRef = incomingRefFor(branch);

  await mkdir(dest);
  try {
    await run(dest, ["init", "--quiet"]);
    // HEAD names the branch before it exists, so the checkout below is
    // one reset, and a clone of a repo whose default branch is not
    // git's own default lands on the right one.
    await run(dest, ["symbolic-ref", "HEAD", branchRef]);
    const { fetched } = await fetchBundleFromPeer(peer.sync, {
      sourceProjectId,
      repoPath: dest,
      refs: [branchRef],
      haves: [],
      onProgress,
    });
    const tip = fetched.find((entry) => entry.ref === incomingRef)?.commit;
    if (tip === undefined) {
      throw new Error(`${branch} did not arrive whole from the other device.`);
    }
    await updateRef(dest, branchRef, tip);
    await deleteRef(dest, incomingRef);
    await run(dest, ["reset", "--quiet", "--hard"]);
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // The checkout stays if registering fails, so the error says where
  // it is: a retry would only find the folder taken.
  return projectsAddViaCli(dest).catch((error: unknown) => {
    throw new Error(
      `Cloned into ${dest}, but couldn't add it as a project: ${errorMessageOf(error)}`,
    );
  });
}
