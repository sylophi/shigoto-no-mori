// Continuous worktree mirroring, renderer side. The list is
// host-scoped (a device's mirrors and the streams it serves are its
// own facts), read through the surrounding scope's api and driven by
// that device's mirror:changed broadcast, so it renders live for this
// machine and for a peer being viewed. The mutations are local: start
// is a pull plus a mirror, and stop/pause/resume speak to this
// machine's daemon.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  MirrorEvent,
  MirrorListResult,
  MirrorSession,
  MirrorServing,
} from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import {
  type MirrorIgnoreChoice,
  type PullSource,
  useLandingMutation,
} from "@/hooks/remote/usePullWorktree";
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
// device runs INTO it (it is the local copy of a peer's worktree), and
// the streams this device serves FROM it (peers mirroring it).
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
  // Stop removes the local copy with the session, so the renderer
  // forgets the worktree the way a delete does.
  const stop = useMutation({
    mutationFn: ({
      session,
      force,
    }: {
      session: MirrorSession;
      force?: boolean;
    }) => window.api.mirror.stop(session.session, force),
    onSuccess: (_data, { session }) =>
      forget(session.localProjectId, session.localWorktreeId),
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
