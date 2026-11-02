// What this host keeps about its mirrors while it works on them, and the
// sweeps and ends that read it, one module per area under ledger/: the
// marks they share (marks.ts), how a session ends (ends.ts), what a
// delete or a move here does to its mirrors (tombstones.ts, moves.ts),
// what every snapshot is checked against (sweep.ts), what a peer coming,
// going or deleting its side does (peers.ts), the transfers and served
// streams running, and the picture all of it makes (listing.ts). Every
// sweep and every end of a session goes through here, so each reads what
// the others are doing.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import type {
  MirrorListResult,
  MirrorServing,
  MirrorSession,
  MirrorStarting,
} from "@shigomori/contracts/modules/mirror";
import type { Stopped } from "@shigomori/engine/MirrorsOnDelete";
import type * as EngineWorktrees from "@shigomori/engine/Worktrees";
import type * as Views from "@host/lib/Views";
import type { MirrorEngine, MirrorError } from "./MirrorEngine";
import type { MirrorSessionRaw } from "./registry";
import { type Copy, makeEnds } from "./ledger/ends";
import { makeChanges, makeListing } from "./ledger/listing";
import { makeMarks } from "./ledger/marks";
import { makeMoves } from "./ledger/moves";
import { makePeers, type Original } from "./ledger/peers";
import { makeStreams } from "./ledger/streams";
import { makeSweep } from "./ledger/sweep";
import { makeTombstones } from "./ledger/tombstones";
import { makeTransfers, type TransferTarget } from "./ledger/transfers";

type Daemon = MirrorEngine["Service"];

export class MirrorLedger extends Context.Service<
  MirrorLedger,
  {
    // ledger/transfers.ts
    readonly beginTransfer: (target: TransferTarget) => string;
    readonly endTransfer: (token: string) => void;
    readonly transferInto: (
      deviceId: string,
      worktreeId: string,
    ) => "in" | "out" | undefined;
    readonly isOrphanedTransfer: (raw: MirrorSessionRaw) => boolean;

    // ledger/streams.ts. The streams served into these worktrees end,
    // and none opens until the release.
    readonly holdServing: (worktreeIds: readonly string[]) => () => void;
    readonly servingHeld: (worktreeId: string) => boolean;
    readonly listServing: () => MirrorServing[];
    readonly noteServing: (
      key: string,
      entry: MirrorServing,
      stop: () => void,
    ) => void;
    readonly forgetServing: (key: string) => void;

    // ledger/listing.ts
    // Something the picture shows may have moved.
    readonly changed: () => void;
    readonly list: () => Effect.Effect<MirrorListResult, never, MirrorEngine>;
    readonly watch: Stream.Stream<
      MirrorListResult,
      unknown,
      Views.Services | MirrorEngine
    >;
    readonly noteStarting: (entry: MirrorStarting) => void;
    readonly forgetStarting: (localWorktreeId: string) => void;
    // `shown` listed in the session's place while `run` removes its copy.
    readonly whileStopping: <A, E, R>(
      session: string,
      shown: MirrorSession,
      run: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;

    // ledger/tombstones.ts
    readonly stopMirrorsForWorktree: (id: string) => Effect.Effect<void>;
    // The sessions found in step before the pause.
    readonly pauseMirrorsOn: (
      ids: readonly string[],
    ) => Effect.Effect<ReadonlySet<string>, MirrorError>;
    readonly copyInStep: (worktreeId: string) => Effect.Effect<boolean>;
    readonly endMirrorsOfKept: (ids: readonly string[]) => Effect.Effect<void>;
    readonly deleteCopiesOf: (
      ids: readonly string[],
      inStep: ReadonlySet<string>,
    ) => Effect.Effect<void>;
    // A peer taking this device's calls again.
    readonly lookAgainAt: (deviceId: string) => void;
    // The original's root vanishing is this delete or move's, not one
    // behind the app's back, until the release.
    readonly holdRootChecks: (worktreeIds: readonly string[]) => () => void;
    readonly keepTerminalStop: (worktreeId: string, stopped: Stopped) => void;
    readonly takeTerminalStop: (worktreeId: string) => Stopped | undefined;

    // ledger/moves.ts
    readonly moveMirrorsOfWorktree: (
      oldId: string,
      moved: { id: string; path: string },
    ) => Effect.Effect<void>;

    // ledger/ends.ts
    readonly endThenDeleteCopy: (
      daemon: Daemon,
      raw: MirrorSessionRaw,
    ) => Effect.Effect<string | undefined, MirrorError>;
    readonly endMirrorKeepingCopy: (
      daemon: Daemon,
      raw: MirrorSessionRaw,
      detail: string,
    ) => Effect.Effect<void, MirrorError>;

    // ledger/marks.ts
    readonly isWaitingOnPeer: (session: string) => boolean;
    readonly isRecreating: (session: string) => boolean;
    readonly whileRecreating: <A, E, R>(
      session: string,
      run: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;

    // ledger/sweep.ts
    readonly settleMirrorBookkeeping: Effect.Effect<
      void,
      never,
      EngineWorktrees.Worktrees
    >;

    // ledger/peers.ts
    readonly endMirrorIfCopyGone: (copy: Copy) => Effect.Effect<boolean>;
    readonly endMirrorsWithPeers: (
      stillOnAccount: (deviceId: string) => boolean,
      detail: string,
    ) => Effect.Effect<void>;
    // A peer's worktrees:removal, answering the originals here a delete
    // of both sides takes too.
    readonly endMirrorsOnPeerRemoval: (
      deviceId: string,
      payload: unknown,
    ) => Effect.Effect<readonly Original[]>;
  }
>()("sm/host/MirrorLedger") {}

const make = Effect.gen(function* () {
  const marks = makeMarks();
  const changes = yield* makeChanges;
  const streams = yield* makeStreams({ changes });
  const ends = yield* makeEnds({ marks });
  const moves = yield* makeMoves({ marks, ends });
  return MirrorLedger.of({
    ...(yield* makeTransfers),
    ...streams,
    ...(yield* makeListing({ changes, streams })),
    ...(yield* makeTombstones({ marks, ends, streams })),
    ...moves,
    ...(yield* makeSweep({ marks, ends, moves })),
    ...(yield* makePeers({ marks, ends })),
    endThenDeleteCopy: ends.endThenDeleteCopy,
    endMirrorKeepingCopy: ends.endMirrorKeepingCopy,
    isWaitingOnPeer: (session) => marks.waitingOnPeer.has(session),
    isRecreating: (session) => marks.recreating.has(session),
    whileRecreating: marks.whileRecreating,
  });
});

export const layer = Layer.effect(MirrorLedger, make);
