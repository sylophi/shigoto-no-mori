// Continuous worktree mirroring, renderer side. The list is
// host-scoped (a device's mirrors and the streams it serves are its
// own facts), read through the surrounding scope's api and driven by
// that device's mirror:changed broadcast, so it renders live for this
// machine and for a peer being viewed. The mutations are local: start
// is a pull plus a mirror, and stop/pause/resume speak to this
// machine's daemon.
import { useEffect, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  mirrorCopyIsRemote,
  type MirrorEvent,
  type MirrorListResult,
  type MirrorSession,
  type MirrorServing,
} from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  type MirrorIgnoreChoice,
  type PullSource,
  useLandingMutation,
  useLandingOnPeer,
} from "@/hooks/remote/usePullWorktree";
import { invalidateHostDevice, localDeviceId } from "@/lib/queryKeys";
import {
  subscribeWorktreeLifecycle,
  worktreeRemoving,
} from "@/store/worktreeLifecycle";
import { useForgetDeletedWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { notifyError } from "@/lib/toast";

const EMPTY: MirrorListResult = {
  daemon: "stopped",
  sessions: [],
  serving: [],
};

// The scoped device's mirror picture, kept fresh by its broadcast. The
// broadcast owns invalidation (the mutations below never invalidate the
// list themselves), matching the port-forward hooks.
export function useMirrors(): MirrorListResult {
  const { api, keys, hasHost } = useHostScope();
  const query = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    enabled: hasHost,
  });
  useMirrorsChanged();
  return query.data ?? EMPTY;
}

// The scoped device's mirror:changed, as the list's refresh. The
// broadcast carries the list, so it is written into the cache with no
// round trip: a busy mirror fires several times a second. An in-flight
// read is cancelled first, or its older answer would land on top. An
// older host sends no list, and that one is re-asked. Every reader of
// the list subscribes, so whichever is mounted (the always-mounted
// sidebar included) keeps the cache fresh.
function useMirrorsChanged(): void {
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      api.mirror.onChanged((list) => {
        const queryKey = keys.mirrors();
        if (list === undefined) {
          void queryClient.invalidateQueries({ queryKey });
          return;
        }
        void queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData(queryKey, list);
      }),
    [api, keys, queryClient],
  );
}

// A mirrored pair as the sidebar folds it: the peer's row (device,
// worktree) that folds into a local row, and the peer device the local
// row wears. A session pairs its local copy with the peer's source. A
// served stream pairs the served worktree with the peer's copy, when
// the peer named it.
export type MirrorLink = {
  peerDeviceId: string;
  peerWorktreeId: string;
  localWorktreeId: string;
};

export function mirrorLinksOf(mirrors: MirrorListResult): MirrorLink[] {
  const links: MirrorLink[] = [];
  for (const session of mirrors.sessions) {
    if (session.localWorktreeId === "") continue;
    links.push({
      peerDeviceId: session.deviceId,
      peerWorktreeId: session.worktreeId,
      localWorktreeId: session.localWorktreeId,
    });
  }
  for (const stream of mirrors.serving) {
    if (stream.peerWorktreeId === undefined) continue;
    links.push({
      peerDeviceId: stream.peerDeviceId,
      peerWorktreeId: stream.peerWorktreeId,
      localWorktreeId: stream.worktreeId,
    });
  }
  return links;
}

const NO_LINKS: MirrorLink[] = [];

const linkKey = (link: MirrorLink) =>
  `${link.peerDeviceId}:${link.peerWorktreeId}:${link.localWorktreeId}`;

// How long a pair whose session just ended is held before its rows
// split, when neither side has (yet) announced a removal. The device
// that stops keeps the session listed until the copy is gone
// (mirror.ts `stopping`), so this is for the device at the other
// end, which only sees its stream close: the announcement of the
// copy's delete trails that by a round trip.
const HELD_LINK_GRACE_MS = 3_000;

type HeldLink = { link: MirrorLink; endedAt: number };
const NO_HELD: ReadonlyMap<string, HeldLink> = new Map();

// The live pairs, plus the pairs whose session just ended while the
// copy it made is still being removed. Without the hold, the sidebar
// would split such a pair for the seconds the delete takes: the copy
// as an ordinary row of its own, the original with its badge gone. A
// held pair is dropped when either of its rows is no longer listed
// (`present`, by device and worktree id) or, if no side announced a
// removal, when the grace runs out. The announced removal itself drops
// the row the moment the copy is gone (boot's worktrees:removal
// follower), so the hold ends with the copy.
export function useHeldMirrorLinks(
  live: MirrorLink[],
  present: (deviceId: string, worktreeId: string) => boolean,
): MirrorLink[] {
  const [held, setHeld] = useState(NO_HELD);
  const [tick, bump] = useReducer((n: number) => n + 1, 0);
  const previous = useRef(live);
  useEffect(() => {
    const before = previous.current;
    previous.current = live;
    const liveKeys = new Set(live.map(linkKey));
    const now = Date.now();
    const next = new Map<string, HeldLink>();
    const consider = (link: MirrorLink, endedAt: number) => {
      const key = linkKey(link);
      if (liveKeys.has(key) || next.has(key)) return;
      if (
        !present(localDeviceId, link.localWorktreeId) ||
        !present(link.peerDeviceId, link.peerWorktreeId)
      ) {
        return;
      }
      const announced =
        worktreeRemoving(localDeviceId, link.localWorktreeId) ||
        worktreeRemoving(link.peerDeviceId, link.peerWorktreeId);
      if (!announced && now - endedAt > HELD_LINK_GRACE_MS) return;
      next.set(key, { link, endedAt });
    };
    for (const entry of held.values()) consider(entry.link, entry.endedAt);
    for (const link of before) consider(link, now);
    const same =
      next.size === held.size && [...next.keys()].every((key) => held.has(key));
    if (!same) setHeld(next);
  }, [live, held, present, tick]);
  // What moves a held pair on: a removal announced (or done) on
  // either side, and the grace running out.
  useEffect(() => {
    if (held.size === 0) return;
    const unsubscribes: Array<() => void> = [];
    let soonest = Number.POSITIVE_INFINITY;
    for (const { link, endedAt } of held.values()) {
      unsubscribes.push(
        subscribeWorktreeLifecycle(localDeviceId, link.localWorktreeId, bump),
        subscribeWorktreeLifecycle(
          link.peerDeviceId,
          link.peerWorktreeId,
          bump,
        ),
      );
      soonest = Math.min(soonest, endedAt + HELD_LINK_GRACE_MS);
    }
    const timer = setTimeout(bump, Math.max(0, soonest - Date.now()) + 1);
    return () => {
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [held]);

  if (held.size === 0) return live;
  return [...live, ...[...held.values()].map((entry) => entry.link)];
}

// The pairs alone, for the always-mounted sidebar: the list moves on
// every cycle of a busy mirror (counts, status), and the projection
// stays referentially the same through all of that, so the rows are
// not rebuilt for news they do not show.
export function useMirrorLinks(): MirrorLink[] {
  const { api, keys, hasHost } = useHostScope();
  const query = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    select: mirrorLinksOf,
    enabled: hasHost,
  });
  useMirrorsChanged();
  return query.data ?? NO_LINKS;
}

// The one mirror picture a worktree row cares about: the session this
// device runs ON it (it is the local copy of a peer's worktree, or the
// original of a copy made on a peer), and the streams this device
// serves FROM it (peers mirroring it).
export function useWorktreeMirror(worktree: Worktree): {
  session: MirrorSession | undefined;
  serving: MirrorServing[];
} {
  const { sessions, serving } = useMirrors();
  return {
    session: sessions.find((s) => s.localWorktreeId === worktree.id),
    serving: serving.filter((s) => s.worktreeId === worktree.id),
  };
}

// Bring the peer's worktree here and keep it mirrored, driven by the
// mirror dialog: the new worktree is LOCAL, so the local registry keys
// are invalidated, and the dialog's last step is the report, so no
// toast here. Refusals surface centrally.
export function useStartMirror(source: PullSource) {
  return useLandingMutation(source, (payload) =>
    window.api.mirror.start(payload),
  );
}

// The mirror the other way: one of this device's worktrees, copied to
// a peer and kept in step from here.
export function useStartMirrorTo(
  worktree: Worktree,
  targetDeviceId: string | undefined,
) {
  return useLandingOnPeer(targetDeviceId, (target, choice) =>
    window.api.mirror.startTo({
      targetDeviceId: target,
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      ...choice,
    }),
  );
}

// The mirror's thread of events (mirror:history), read through the
// scope like the list and refreshed by the same broadcast: the key
// sits under the mirrors prefix the list's invalidation sweeps.
export function useMirrorHistory(localWorktreeId: string) {
  const { api, keys } = useHostScope();
  return useQuery<MirrorEvent[]>({
    queryKey: keys.mirrorHistory(localWorktreeId),
    queryFn: async () => (await api.mirror.history({ localWorktreeId })).events,
    meta: { silentError: true },
  });
}

// Changing what a running mirror leaves out. Local by contract, like
// the other controls. The list refreshes off the daemon's snapshot.
export function useSetMirrorIgnores() {
  return useMutation({
    mutationFn: (input: { session: string } & MirrorIgnoreChoice) =>
      window.api.mirror.setIgnores(input),
    onError: (err) =>
      notifyError("Couldn't change what the mirror leaves out", err),
    meta: { silentError: true },
  });
}

// This machine's daemon controls. Local by contract. The list refreshes
// off the daemon's own state snapshot.
export function useMirrorControls() {
  const forget = useForgetDeletedWorktree();
  const queryClient = useQueryClient();
  // Stop removes the copy with the session. A local copy the renderer
  // forgets the way a delete does. A copy on the peer (a mirror
  // started to it) is that device's view to refresh.
  const stop = useMutation({
    mutationFn: ({
      session,
      force,
    }: {
      session: MirrorSession;
      force?: boolean;
    }) => window.api.mirror.stop(session.session, force),
    onSuccess: (_data, { session }) =>
      mirrorCopyIsRemote(session)
        ? invalidateHostDevice(queryClient, session.deviceId)
        : forget(session.localProjectId, session.localWorktreeId),
    onError: (err) => notifyError("Couldn't stop mirroring", err),
    meta: { silentError: true },
  });
  const pause = useMutation({
    mutationFn: (session: string) => window.api.mirror.pause(session),
    onError: (err) => notifyError("Couldn't pause mirroring", err),
    meta: { silentError: true },
  });
  const resume = useMutation({
    mutationFn: (session: string) => window.api.mirror.resume(session),
    onError: (err) => notifyError("Couldn't resume mirroring", err),
    meta: { silentError: true },
  });
  return { stop, pause, resume };
}
