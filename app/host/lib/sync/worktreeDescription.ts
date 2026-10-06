// A worktree's title and description (WorktreeDescriptionSchema)
// going where the worktree goes: onto the copy a send or a pull
// lands, and between the two sides of a mirror for as long as it
// runs. They live in each device's own data file, and the pair set
// last (describedAt) is the one both keep.
//
// Never fatal to what carries it: the worktree is real either way,
// and a peer from before the field answers the write with an unknown
// channel. The callers log a failure and move on.
import type {
  ShigomoriWorktreeData,
  WorktreeDescription,
} from "@shared/schemas";
import {
  readWorktreeData,
  writeWorktreeDescription,
} from "@host/lib/config/project";
import { peerShigomoriApiFor } from "@host/ipc/peerSync";

export type WorktreeRef = { projectId: string; worktreeId: string };

function descriptionOf(
  data: ShigomoriWorktreeData | null,
): WorktreeDescription {
  return {
    title: data?.title,
    description: data?.description,
    describedAt: data?.describedAt,
  };
}

// Whichever side was described last, onto the other, answering which
// side it wrote, if either. A copy a move just landed has nothing of
// its own yet, so the move's original wins. A mirror's two sides each
// take describes, so either can.
export async function followDescription(
  deviceId: string,
  local: WorktreeRef,
  peer: WorktreeRef,
): Promise<"here" | "there" | null> {
  const api = peerShigomoriApiFor(deviceId);
  const [here, there] = await Promise.all([
    readWorktreeData(local.projectId, local.worktreeId).then(descriptionOf),
    api.worktreeDataRead(peer).then(descriptionOf),
  ]);
  const hereAt = here.describedAt ?? 0;
  const thereAt = there.describedAt ?? 0;
  if (hereAt > thereAt) {
    await api.worktreeDataDescribe({ ...peer, description: here });
    return "there";
  }
  if (thereAt > hereAt) {
    await writeWorktreeDescription(local.projectId, local.worktreeId, there);
    return "here";
  }
  return null;
}
