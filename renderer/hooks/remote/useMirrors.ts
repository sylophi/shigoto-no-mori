// Continuous worktree mirroring, renderer side. The list is
// host-scoped (a device's mirrors and the streams it serves are its
// own facts), read through the surrounding scope's api and driven by
// that device's mirror:changed broadcast, so it renders live for this
// machine and for a peer being viewed. The mutations are local: start
// is a bring-here plus a mirror, and stop/pause/resume speak to this
// machine's daemon.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type {
  MirrorListResult,
  MirrorSession,
  MirrorServing,
} from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { useHostScope } from "@/hooks/remote/useHostScope";
import { reportLanded } from "@/hooks/remote/useBringWorktreeHere";
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
  const { api, keys } = useHostScope();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
  });
  useEffect(
    () =>
      api.mirror.onChanged(() => {
        void queryClient.invalidateQueries({ queryKey: keys.mirrors() });
      }),
    [api, keys, queryClient],
  );
  return query.data ?? EMPTY;
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

// Bring the peer's worktree here and keep it mirrored. Mirrors the
// bring-here mutation's shape and reporting: the new worktree is
// LOCAL, so the local registry keys are invalidated, and the toast is
// usually the only visible conclusion (the result lands on another
// page).
export function useStartMirror({
  worktree,
  sourceProjectId,
  sourceIdentity,
  localProjectId,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  localProjectId: string;
}) {
  const { deviceId } = useHostScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      window.api.mirror.start({
        sourceDeviceId: deviceId,
        sourceProjectId,
        sourceWorktreeId: worktree.id,
        sourceIdentity,
        branch: worktree.branch,
      }),
    onSuccess: (result) =>
      reportLanded(
        queryClient,
        localProjectId,
        result,
        `Mirroring ${worktree.branch} here`,
      ),
    onError: (err) => {
      if (!isCommandRefusedError(err)) {
        notifyError("Couldn't mirror worktree here", err);
      }
    },
    meta: { silentError: true },
  });
}

// This machine's daemon controls. Local by contract. The list refreshes
// off the daemon's own state snapshot.
export function useMirrorControls() {
  const stop = useMutation({
    mutationFn: (session: string) => window.api.mirror.stop(session),
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
