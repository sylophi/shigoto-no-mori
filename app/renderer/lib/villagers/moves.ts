// Villagers moving in and out, whoever moved them. A worktree named
// after a character appearing is them moving in, and one going is them
// moving out, and the app says so (toastVillagerMove) however it
// happened: from this app, from `sm` in a terminal, or from another
// device. So rather than hooking the app's own create and remove, this
// watches what every one of those ends in: a device's worktree list
// coming back from the host different. The CLI's changes reach it
// through the fs watcher's refetch, and another device's through the
// peer push that invalidates its lists (lib/hostWatch.ts).
//
// It compares each list only against the last one fetched for the same
// key, never against a write the app made to the cache itself (an
// optimistic removal, or its rollback), so a move counts once it is on
// the host. A list seen for the first time, or again after it failed or
// left the cache, starts over without news: nothing moved that this
// window saw.
//
// Moves wait a moment before they are told, so several at once come
// out together, and a hold (holdVillagerMoves) keeps them waiting for
// as long as a batch runs. A flow that tells of a worktree coming or
// going itself (a transplant, a mirror) quiets its moves
// (quietVillagerMoves), so one action is one piece of news.
import type { QueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { toastVillagerMove } from "@/components/villagers/toasts";
import { hostScopeOf } from "@/hooks/remote/useHostScope";
import { hostKeyDeviceId, isWorktreeListKey } from "@/lib/queryKeys";
import { remoteDeviceById } from "@/lib/remote/devices";
import {
  type MoveKind,
  moveNewsFor,
  netMoves,
  worktreeMoves,
} from "@/lib/villagerVoice";
import { speakersFor } from "./speakers";

// How long moves gather before they are told, and after a batch lets
// go of its hold, long enough for its last step's list to come back.
const SETTLE_MS = 800;
const RELEASE_SETTLE_MS = 2_500;
// How long a quieted worktree stays quiet: a transplant's whole dialog.
const QUIET_MS = 5 * 60_000;

// The last list fetched for each project, by query hash.
const lastSeen = new Map<string, Worktree[]>();
// Moves not yet told, by device.
const pending = new Map<string, { in: Worktree[]; out: Worktree[] }>();
let holds = 0;
// Worktrees whose moves are someone else's news, by id or name, until
// when.
const quiet = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let client: QueryClient | undefined;

// Boot wiring, once per window, like the other boot subscriptions.
export function startVillagerMoves(queryClient: QueryClient): void {
  client = queryClient;
  queryClient.getQueryCache().subscribe((event) => {
    const { queryKey, queryHash } = event.query;
    if (!isWorktreeListKey(queryKey)) return;
    if (event.type === "removed") {
      lastSeen.delete(queryHash);
      return;
    }
    if (event.type !== "updated") return;
    const { action } = event;
    if (action.type === "error") {
      lastSeen.delete(queryHash);
      return;
    }
    if (action.type !== "success" || action.manual) return;
    const list = event.query.state.data as Worktree[] | undefined;
    const before = lastSeen.get(queryHash);
    // Structural sharing hands back the same list when nothing changed.
    if (list === undefined || list === before) return;
    lastSeen.set(queryHash, list);
    if (before === undefined) return;
    const { movedIn, movedOut } = worktreeMoves(before, list);
    if (movedIn.length === 0 && movedOut.length === 0) return;
    const deviceId = String(hostKeyDeviceId(queryKey));
    const moves = pending.get(deviceId) ?? { in: [], out: [] };
    moves.in.push(...movedIn);
    moves.out.push(...movedOut);
    pending.set(deviceId, moves);
    settle();
  });
}

// Keeps moves from being told until the returned release is called,
// then tells them all at once. For a batch that moves several villagers
// one at a time (useSequentialBatch takes one for every run).
export function holdVillagerMoves(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    // Through a longer settle wait, so the refetch after the batch's
    // last step still makes it in.
    settle(RELEASE_SETTLE_MS);
  };
}

// Leaves the moves of these worktrees (by id or by name, on any device)
// untold for a while: the flow moving them tells of it itself.
export function quietVillagerMoves(keys: readonly string[]): void {
  const until = Date.now() + QUIET_MS;
  for (const key of keys) quiet.set(key, until);
}

function isQuiet(worktree: Worktree): boolean {
  const now = Date.now();
  return [worktree.id, worktree.name].some(
    (key) => (quiet.get(key) ?? 0) > now,
  );
}

function settle(ms = SETTLE_MS): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (holds === 0 && client !== undefined) void tell(client);
  }, ms);
}

function settled(moves: { in: Worktree[]; out: Worktree[] }) {
  const { movedIn, movedOut } = netMoves(moves.in, moves.out);
  return {
    movedIn: movedIn.filter((w) => !isQuiet(w)),
    movedOut: movedOut.filter((w) => !isQuiet(w)),
  };
}

async function tell(queryClient: QueryClient): Promise<void> {
  const batch = [...pending];
  pending.clear();
  await Promise.all(
    batch.map(async ([deviceId, moves]) => {
      const { movedIn, movedOut } = settled(moves);
      const scope = hostScopeOf(deviceId);
      if (scope === undefined) return;
      const speakers = await speakersFor(
        queryClient,
        scope,
        [...movedIn, ...movedOut],
        { withColor: true },
      );
      const device = scope.remote
        ? remoteDeviceById(deviceId)?.label
        : undefined;
      const told: [MoveKind, Worktree[]][] = [
        ["in", movedIn],
        ["out", movedOut],
      ];
      for (const [kind, worktrees] of told) {
        for (const news of moveNewsFor(kind, worktrees, speakers, device)) {
          const ids = news.worktreeIds.join(",");
          toastVillagerMove(news, `villagers:${kind}:${deviceId}:${ids}`);
        }
      }
    }),
  );
}
