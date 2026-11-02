// The mirror streams this host serves a peer (host/mirror/serving.ts).
import * as Effect from "effect/Effect";
import type { MirrorServing } from "@shigomori/contracts/modules/mirror";
import type { Changes } from "./listing";
import { countedHolds } from "./marks";

export const makeStreams = ({ changes }: { readonly changes: Changes }) =>
  Effect.sync(() => {
    // The mirror streams this host currently serves, keyed by the calling
    // device and the channel id it minted (unique per connection, so the
    // pair is what identifies a stream host-wide): what mirror:list
    // reports as `serving`, so a worktree shows "mirrored to <device>" on
    // the machine it lives on. Entries live exactly as long as their
    // channel.
    const serving = new Map<string, MirrorServing>();
    // How each of those streams' child is ended, under the same key.
    const stops = new Map<string, () => void>();
    // Those of them a move's files step opened, not a mirror.
    const transfers = new Set<string>();

    // Worktrees being deleted here: the streams into them end, and none
    // opens until the delete is done, so nothing crosses while their files
    // go (the mirror runs on the peer, which this device can't pause).
    const held = countedHolds();

    const holdServing = (worktreeIds: readonly string[]): (() => void) => {
      const release = held.hold(worktreeIds);
      for (const [key, entry] of serving) {
        if (worktreeIds.includes(entry.worktreeId)) stops.get(key)?.();
      }
      return release;
    };

    const listServing = (): MirrorServing[] => [...serving.values()];

    // The stream a mirror on the peer has into a copy here.
    const mirrorStreamInto = (worktreeId: string): MirrorServing | undefined =>
      [...serving].find(
        ([key, entry]) =>
          entry.worktreeId === worktreeId && !transfers.has(key),
      )?.[1];

    const noteServing = (
      key: string,
      entry: MirrorServing,
      stop: () => void,
      transfer = false,
    ): void => {
      stops.set(key, stop);
      serving.set(key, entry);
      if (transfer) transfers.add(key);
      changes.changed();
    };

    const forgetServing = (key: string): void => {
      stops.delete(key);
      transfers.delete(key);
      if (serving.delete(key)) changes.changed();
    };

    return {
      holdServing,
      servingHeld: held.has,
      listServing,
      mirrorStreamInto,
      noteServing,
      forgetServing,
    };
  });

export type Streams = Effect.Success<ReturnType<typeof makeStreams>>;
