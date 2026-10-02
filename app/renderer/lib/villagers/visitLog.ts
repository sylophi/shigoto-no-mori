// The Visitors album's record: every worktree named after a villager
// that this app has seen, on any device it shows, while Village life
// shows. A purely visual extra like the rest of Village life, so the
// app keeps it on its own (localStorage), and nothing on a device knows
// about it.
//
// A worktree counts once, keyed by its device, its place (project and
// name, keyOf: a relocate changes its id but not the visit) and when it
// was made, so seeing a list again changes nothing and a worktree made
// again under the same name is a new visit. Residents count the first
// time the app sees them, so the album starts from whoever lives here
// now, and a villager who moved in while the app was closed counts once
// it opens, as long as they still live there. A copy a mirror or a
// transplant lands (quietVillagerMoves) is the same visit, counted
// where it began, so it is kept as seen but not counted.
import type { QueryClient } from "@tanstack/react-query";
import type { Worktree } from "@shared/schemas";
import { readStoredJson, writeStored } from "@/lib/localStorage";
import { hostKeyDeviceId, isWorktreeListKey } from "@/lib/queryKeys";
import { keyOf, residentOf } from "@/lib/villagerVoice";
import { createExternalStore, useExternalStore } from "@/store/externalStore";
import { villageProfiles } from "./speakers";

const LOG_KEY = "villagers.visits";

// A visit: who, and when (epoch ms). Null for a copy.
export type VisitEntry = { slug: string; at: number } | null;
export type VisitLog = Readonly<Record<string, VisitEntry>>;

// Anything but a visit or a copy (a hand-edited or corrupt record) is
// dropped.
function readLog(): VisitLog {
  const stored = readStoredJson<Record<string, unknown>>(LOG_KEY, {});
  return Object.fromEntries(
    Object.entries(stored).filter(
      (entry): entry is [string, VisitEntry] =>
        entry[1] === null ||
        (typeof entry[1] === "object" &&
          typeof (entry[1] as { slug?: unknown }).slug === "string" &&
          Number.isFinite((entry[1] as { at?: unknown }).at)),
    ),
  );
}

const log = createExternalStore<VisitLog>(readLog());

export function useVisitLog(): VisitLog {
  return useExternalStore(log);
}

// Adds one device's villager worktrees to the log, the ones it doesn't
// hold yet. `isCopy` names a mirror's or a transplant's.
export async function recordVisits(
  queryClient: QueryClient,
  deviceId: string,
  worktrees: readonly Worktree[],
  isCopy: (worktree: Worktree) => boolean = () => false,
): Promise<void> {
  const profiles = await villageProfiles(queryClient).catch(() => null);
  if (profiles === null) return;
  const held = log.get();
  let next: Record<string, VisitEntry> | undefined;
  for (const worktree of worktrees) {
    const slug = residentOf(worktree, profiles)?.slug;
    if (slug === undefined) continue;
    const key = `${deviceId}:${keyOf(worktree)}:${worktree.createdAt ?? ""}`;
    if (Object.hasOwn(held, key)) continue;
    next ??= { ...held };
    next[key] = isCopy(worktree)
      ? null
      : { slug, at: worktree.createdAt ?? Date.now() };
  }
  if (next === undefined) return;
  writeStored(LOG_KEY, JSON.stringify(next));
  log.publish(next);
}

// Every worktree list the window holds, for when the album opens: the
// lists may not change again for a while.
export async function recordCachedVisits(
  queryClient: QueryClient,
): Promise<void> {
  const lists = queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => isWorktreeListKey(query.queryKey) });
  // Each one reads the log and writes it back in one step, after its
  // await, so they can run together.
  await Promise.all(
    lists.map((query) => {
      const list = query.state.data as Worktree[] | undefined;
      return list === undefined
        ? undefined
        : recordVisits(
            queryClient,
            String(hostKeyDeviceId(query.queryKey)),
            list,
          );
    }),
  );
}
