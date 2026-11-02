// A worktree's title and description (WorktreeDescriptionSchema)
// going where the worktree goes: onto the copy a send or a pull
// lands, and between the two sides of a mirror for as long as it
// runs. They live in each device's own data file, and the pair set
// last (describedAt) is the one both keep.
//
// Never fatal to what carries it: the worktree is real either way. The
// callers log a failure and move on.
import type {
  ShigomoriWorktreeData,
  WorktreeDescription,
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import { peerWorktreeDataFor } from "@host/ipc/PeerReach";
import * as WorktreeData from "@shigomori/engine/WorktreeData";

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

// The title and description as a whole, onto this side's worktree. Only
// a pair described after the one stored lands, so a carry that read a
// stale side can't undo a newer describe.
export const writeDescription = (
  { projectId, worktreeId }: WorktreeRef,
  { title, description, describedAt }: WorktreeDescription,
) =>
  Effect.flatMap(WorktreeData.WorktreeData, (data) =>
    data.carry(projectId, worktreeId, {
      title: title ?? "",
      description: description ?? "",
      describedAt: describedAt ?? 0,
    }),
  );

// Whichever side was described last, onto the other, answering which
// side it wrote, if either. A copy a move just landed has nothing of
// its own yet, so the move's original wins. A mirror's two sides each
// take describes, so either can.
export const followDescription = Effect.fnUntraced(function* (
  deviceId: string,
  local: WorktreeRef,
  peer: WorktreeRef,
) {
  const api = peerWorktreeDataFor(deviceId);
  const [here, there] = yield* Effect.all(
    [
      Effect.map(
        Effect.flatMap(WorktreeData.WorktreeData, (worktreeData) =>
          worktreeData.document(local.projectId, local.worktreeId),
        ),
        descriptionOf,
      ),
      Effect.map(api.read(peer), descriptionOf),
    ],
    { concurrency: 2 },
  );
  const hereAt = here.describedAt ?? 0;
  const thereAt = there.describedAt ?? 0;
  if (hereAt > thereAt) {
    yield* api.describe({ ...peer, description: here });
    return "there" as const;
  }
  if (thereAt > hereAt) {
    yield* writeDescription(local, there);
    return "here" as const;
  }
  // Both described in the same millisecond, differently: this side
  // wins (the original, for a mirror, which runs here). It is stamped
  // a millisecond on, here and there, since a write only lands when it
  // is newer than what the other side holds.
  if (here.title !== there.title || here.description !== there.description) {
    const winner = { ...here, describedAt: hereAt + 1 };
    yield* writeDescription(local, winner);
    yield* api.describe({ ...peer, description: winner });
    return "there" as const;
  }
  return null;
});
