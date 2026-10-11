// What the mirror's serving side tells the root (serving.ts): the set
// of streams this host serves changed, a served worktree's index moved,
// or a peer's follower landed its side's git state here. Told from the
// streams' own callbacks, so the calls are synchronous. The root
// provides it (process/handlers.ts): the first goes out on the mirror's
// changed push, the second to the device mirroring the worktree, the
// third as the project's own git change.
import * as Context from "effect/Context";

export class MirrorSignals extends Context.Service<
  MirrorSignals,
  {
    readonly servingChanged: () => void;
    readonly gitChanged: (change: {
      readonly projectId: string;
      readonly worktreeId: string;
    }) => void;
    readonly gitApplied: (projectId: string) => void;
  }
>()("sm/host/MirrorSignals") {}
