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
} from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as Ops from "@host/lib/engineOps";
import { peerWorktreeDataApiFor } from "@host/ipc/peerSync";
import { fromPromise } from "@host/lib/util/fromPromise";

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
export const followDescription = Effect.fnUntraced(function* (
  deviceId: string,
  local: WorktreeRef,
  peer: WorktreeRef,
) {
  const api = peerWorktreeDataApiFor(deviceId);
  const [here, there] = yield* Effect.all(
    [
      Effect.map(
        Ops.readWorktreeData(local.projectId, local.worktreeId),
        descriptionOf,
      ),
      Effect.map(
        fromPromise(() => api.read(peer)),
        descriptionOf,
      ),
    ],
    { concurrency: 2 },
  );
  const hereAt = here.describedAt ?? 0;
  const thereAt = there.describedAt ?? 0;
  if (hereAt > thereAt) {
    yield* fromPromise(() => api.describe({ ...peer, description: here }));
    return "there" as const;
  }
  if (thereAt > hereAt) {
    yield* Ops.writeWorktreeDescription(
      local.projectId,
      local.worktreeId,
      there,
    );
    return "here" as const;
  }
  // Both described in the same millisecond, differently: this side
  // wins (the original, for a mirror, which runs here). It is stamped
  // a millisecond on, here and there, since a write only lands when it
  // is newer than what the other side holds.
  if (here.title !== there.title || here.description !== there.description) {
    const winner = { ...here, describedAt: hereAt + 1 };
    yield* Ops.writeWorktreeDescription(
      local.projectId,
      local.worktreeId,
      winner,
    );
    yield* fromPromise(() => api.describe({ ...peer, description: winner }));
    return "there" as const;
  }
  return null;
});
