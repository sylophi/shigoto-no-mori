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
// it opens, as long as they still live there.
//
// A copy a mirror or a transfer lands is the same visit, counted where
// it began, so it is kept as seen but not counted. A copy is a villager
// worktree whose repo (Project.identity) already holds a counted
// worktree of the same name, live on another device, which holds
// whenever this window first sees it. A transfer that tears its source
// down before then is caught by the move this window started
// (quietVillagerMoves), passed in as `quiet`.
//
// Starting the album over (resetVisits) leaves the log as it is and
// counts from then on: a visit is when its worktree was made, so the
// residents of the day, a device not heard from yet included, stay
// before it, and a copy is still found against what it copied.
import type { QueryClient } from "@tanstack/react-query";
import type { Project, Worktree } from "@shigomori/contracts/schemas";
import { readStored, readStoredJson, writeStored } from "@/lib/localStorage";
import {
  hostKeyDeviceId,
  isWorktreeListKey,
  queryKeysFor,
} from "@/lib/queryKeys";
import { keyOf, residentOf } from "@shigomori/ui/lib/villagerVoice.ts";
import {
  createExternalStore,
  useExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import { villageProfiles } from "./speakers";

const LOG_KEY = "villagers.visits";

// A visit: who, and when (epoch ms). Null for a copy.
type VisitEntry = { slug: string; at: number } | null;
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

const SINCE_KEY = "villagers.visits.since";

// When the album was last started over (epoch ms), 0 for never.
const since = createExternalStore<number>(Number(readStored(SINCE_KEY)) || 0);

export function useVisitsSince(): number {
  return useExternalStore(since);
}

export function resetVisits(): void {
  const now = Date.now();
  writeStored(SINCE_KEY, String(now));
  since.publish(now);
}

// A worktree's key in the log: its device, its place and when it was
// made.
function visitKey(deviceId: string, worktree: Worktree): string {
  return `${deviceId}:${keyOf(worktree)}:${worktree.createdAt ?? ""}`;
}

// Every worktree list the window holds, with the device it is from.
function cachedLists(
  queryClient: QueryClient,
): { deviceId: string; list: readonly Worktree[] }[] {
  return queryClient
    .getQueryCache()
    .findAll({ predicate: (query) => isWorktreeListKey(query.queryKey) })
    .flatMap((query) => {
      const list = query.state.data as readonly Worktree[] | undefined;
      return list === undefined
        ? []
        : [{ deviceId: String(hostKeyDeviceId(query.queryKey)), list }];
    });
}

// The repo a device's project is a checkout of, or null when unknown.
function repoOf(
  queryClient: QueryClient,
  deviceId: string,
  projectId: string,
): string | null {
  const projects = queryClient.getQueryData<readonly Project[]>(
    queryKeysFor(deviceId).projects(),
  );
  return (
    projects?.find((project) => project.id === projectId)?.identity ?? null
  );
}

// Whether `worktree` is a copy of a counted worktree on another device
// (see the header).
function isCopy(
  queryClient: QueryClient,
  held: VisitLog,
  deviceId: string,
  worktree: Worktree,
): boolean {
  const repo = repoOf(queryClient, deviceId, worktree.projectId);
  if (repo === null) return false;
  return cachedLists(queryClient).some(
    (other) =>
      other.deviceId !== deviceId &&
      other.list.some(
        (candidate) =>
          candidate.name === worktree.name &&
          !candidate.isPrimary &&
          held[visitKey(other.deviceId, candidate)] != null &&
          repoOf(queryClient, other.deviceId, candidate.projectId) === repo,
      ),
  );
}

// Adds one device's villager worktrees to the log, the ones it doesn't
// hold yet. `quiet` names a copy this window's own move landed.
export async function recordVisits(
  queryClient: QueryClient,
  deviceId: string,
  worktrees: readonly Worktree[],
  quiet: (worktree: Worktree) => boolean,
): Promise<void> {
  const profiles = await villageProfiles(queryClient).catch(() => null);
  if (profiles === null) return;
  const next: Record<string, VisitEntry> = { ...log.get() };
  let changed = false;
  for (const worktree of worktrees) {
    const slug = residentOf(worktree, profiles)?.slug;
    if (slug === undefined) continue;
    const key = visitKey(deviceId, worktree);
    if (Object.hasOwn(next, key)) continue;
    changed = true;
    // Seen before the device reported when it was made (an older
    // build): the same worktree, now under its full key.
    const unstamped = `${deviceId}:${keyOf(worktree)}:`;
    if (worktree.createdAt !== undefined && Object.hasOwn(next, unstamped)) {
      next[key] = next[unstamped] ?? null;
      delete next[unstamped];
      continue;
    }
    next[key] =
      quiet(worktree) || isCopy(queryClient, next, deviceId, worktree)
        ? null
        : { slug, at: worktree.createdAt ?? Date.now() };
  }
  if (!changed) return;
  writeStored(LOG_KEY, JSON.stringify(next));
  log.publish(next);
}

// Every worktree list the window holds, for when the album opens: the
// lists may not change again for a while.
export async function recordCachedVisits(
  queryClient: QueryClient,
  quiet: (worktree: Worktree) => boolean,
): Promise<void> {
  // Each one reads the log and writes it back in one step, after its
  // await, so they can run together.
  await Promise.all(
    cachedLists(queryClient).map(({ deviceId, list }) =>
      recordVisits(queryClient, deviceId, list, quiet),
    ),
  );
}
