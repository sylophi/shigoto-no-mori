// Villagers moving in and out, whoever moved them. A worktree named
// after a character appearing is them moving in, and one going is them
// moving out, and the app says so (toastVillagerMove) however it
// happened: from this app, from `sm` in a terminal, or from another
// device. It watches what every one of those ends in: a device's
// worktree list changing, the same list the sidebar shows, so the news
// comes with the row. The app's own create and delete write their row
// into the list the moment the host answers (useWorktreeMutations.ts),
// the CLI's changes reach it through the fs watcher's refetch, and
// another device's through the peer push that invalidates its lists
// (lib/hostWatch.ts).
//
// Every write to a list counts, the app's own included, so the app
// adds or drops a row only once the host has made or removed the
// worktree, never optimistically. A re-key (a convert, a relocate) nets
// out by name. A list seen for the first time, or again after it
// failed or left the cache, starts over without news: nothing moved
// that this window saw.
//
// Moves wait a moment before they are told, so several at once come
// out together, and a hold (holdVillagerMoves) keeps them waiting for
// as long as a batch runs. Moves made one at a time join the news
// still showing about the same kind of move, until it closes. A flow
// that tells of a worktree coming or going itself (a transplant, a
// mirror) quiets its moves (quietVillagerMoves), so one action is one
// piece of news.
import type { QueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shigomori/contracts/schemas";
import { villageNewsEnabled } from "@shared/villageLife";
import { toastVillagerMove } from "@/components/villagers/toasts";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { hostScopeOf } from "@/hooks/remote/useHostScope";
import { hostKeyDeviceId, isWorktreeListKey } from "@/lib/queryKeys";
import { remoteDeviceById } from "@/lib/remote/devices";
import {
  type MoveKind,
  moveNews,
  moveGroup,
  moveNewsFor,
  netMoves,
  type Speaker,
  worktreeMoves,
} from "@shigomori/ui/lib/villagerVoice.ts";
import { speakersFor } from "./speakers";
import { recordVisits } from "./visitLog";

// Short enough not to read as late.
const SETTLE_MS = 150;
// How long a quieted worktree stays quiet: a transplant's whole dialog.
const QUIET_MS = 5 * 60_000;

// The last list seen for each project, by query hash.
const lastSeen = new Map<string, Worktree[]>();
// Moves not yet told, by device.
const pending = new Map<string, { in: Worktree[]; out: Worktree[] }>();
let holds = 0;
// News still showing, by device, kind and group (moveGroup), with the
// worktrees it tells of and their speakers by worktree id, until it
// closes.
const showing = new Map<
  string,
  { id: string; worktrees: Worktree[]; speakers: Map<string, Speaker> }
>();
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
    if (action.type !== "success") return;
    const list = event.query.state.data as Worktree[] | undefined;
    const before = lastSeen.get(queryHash);
    // Structural sharing hands back the same list when nothing changed.
    if (list === undefined || list === before) return;
    lastSeen.set(queryHash, list);
    const deviceId = String(hostKeyDeviceId(queryKey));
    // The album counts every villager it sees, a list's first reading
    // included (visitLog.ts).
    void recordVisits(queryClient, deviceId, list, isQuiet);
    if (before === undefined) return;
    const { movedIn, movedOut } = worktreeMoves(before, list);
    if (movedIn.length === 0 && movedOut.length === 0) return;
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
    settle();
  };
}

// Leaves the moves of these worktrees (by id or by name, on any device)
// untold for a while: the flow moving them tells of it itself.
export function quietVillagerMoves(keys: readonly string[]): void {
  const until = Date.now() + QUIET_MS;
  for (const key of keys) quiet.set(key, until);
}

// Whether a worktree's moves are someone else's news right now
// (quietVillagerMoves). The visit log (visitLog.ts) reads it too.
export function isQuiet(worktree: Worktree): boolean {
  const now = Date.now();
  return [worktree.id, worktree.name].some(
    (key) => (quiet.get(key) ?? 0) > now,
  );
}

function settle(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (holds === 0 && client !== undefined) void tell(client);
  }, SETTLE_MS);
}

function settled(moves: { in: Worktree[]; out: Worktree[] }) {
  const { movedIn, movedOut } = netMoves(moves.in, moves.out);
  return {
    movedIn: movedIn.filter((w) => !isQuiet(w)),
    movedOut: movedOut.filter((w) => !isQuiet(w)),
  };
}

// Forgets the news under `key` once its toast closes, unless a newer
// one has taken its place.
function forget(key: string, id: string): () => void {
  return () => {
    if (showing.get(key)?.id === id) showing.delete(key);
  };
}

async function tell(queryClient: QueryClient): Promise<void> {
  const batch = [...pending];
  pending.clear();
  // Village news off, the moves go untold. The album still counts
  // them (visitLog.ts).
  const config = await queryClient
    .ensureQueryData({ ...clientConfigQueryOptions, retry: false })
    .catch(() => undefined);
  if (!config || !villageNewsEnabled(config)) return;
  await Promise.all(
    batch.map(async ([deviceId, moves]) => {
      const { movedIn, movedOut } = settled(moves);
      const scope = hostScopeOf(deviceId);
      if (scope === undefined) return;
      const speakers = await speakersFor(
        queryClient,
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
        for (const fresh of moveNewsFor(kind, worktrees, speakers, device)) {
          const key = [deviceId, kind, moveGroup(fresh.speakers[0])].join(
            "\u0000",
          );
          const shown = showing.get(key);
          const ids = new Set(fresh.worktreeIds);
          const moved = [
            ...(shown?.worktrees.filter((w) => !ids.has(w.id)) ?? []),
            ...worktrees.filter((w) => ids.has(w.id)),
          ];
          const voices = new Map(
            moved.flatMap((w) => {
              const speaker = speakers.get(w.id) ?? shown?.speakers.get(w.id);
              return speaker === undefined ? [] : [[w.id, speaker] as const];
            }),
          );
          const news = moveNews(kind, moved, voices, device) ?? fresh;
          // Told again under its id, a toast still showing changes in
          // place.
          const id =
            shown?.id ?? `villagers:${kind}:${deviceId}:${[...ids].join(",")}`;
          const before = new Set(
            [...(shown?.speakers.values() ?? [])].map((s) => s.slug),
          );
          showing.set(key, { id, worktrees: moved, speakers: voices });
          toastVillagerMove(news, id, {
            joined:
              shown &&
              new Set(
                fresh.speakers
                  .map((s) => s.slug)
                  .filter((slug) => !before.has(slug)),
              ),
            onClose: forget(key, id),
          });
        }
      }
    }),
  );
}
