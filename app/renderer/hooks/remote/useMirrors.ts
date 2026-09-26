// Continuous worktree mirroring, renderer side. The list is
// host-scoped (a device's mirrors and the streams it serves are its
// own facts), read through the surrounding scope's api. Every device's
// list is kept live by its own mirror:changed broadcast, through its
// push watch (lib/hostWatch.ts), so nothing here subscribes. A mirror
// runs on the device holding the original: the start is a send plus a
// mirror on that device's daemon, this machine's for "Mirror to", the
// peer's for "Mirror here". The controls (stop, pause, resume, the
// ignore rule) go to the device RUNNING the session through the scope
// they are mounted under, which is that device's: its own page, or the
// far end's page re-scoped to it (useWorktreeMirrorLinks).
import type { QueryClient } from "@tanstack/react-query";
import {
  queryOptions,
  skipToken,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  mirrorEngineBlocker,
  type MirrorEvent,
  type MirrorListResult,
  type MirrorSession,
  type MirrorServing,
} from "@shared/ipc/modules/mirror";
import type { Worktree } from "@shared/schemas";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import {
  type MirrorIgnoreChoice,
  type Move,
  useMoveMutation,
} from "@/hooks/remote/useMoveWorktree";
import { useHostDevices } from "@/hooks/remote/useRemoteDevices";
import { useAcceptsCommands } from "@/hooks/account/useAccount";
import { hasLocalHost } from "@/lib/localHost";
import {
  invalidateHostDevice,
  localDeviceId,
  queryKeys,
  queryKeysFor,
} from "@/lib/queryKeys";
import { forgetDeletedWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { notifyError } from "@/lib/toast";

const EMPTY: MirrorListResult = {
  daemon: "stopped",
  sessions: [],
  serving: [],
};

// The scoped device's mirror picture, kept fresh by its broadcast at
// boot. The broadcast owns invalidation (the mutations below never
// invalidate the list themselves), matching the port-forward hooks.
export function useMirrors(): MirrorListResult {
  const { api, keys, hasHost } = useHostScope();
  const query = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    enabled: hasHost,
  });
  return query.data ?? EMPTY;
}

// Why this machine can't start a mirror of one of its worktrees right
// now ("Mirror to…"), or undefined when it can. The session runs on
// the local daemon, so this reads this device's list whatever the
// scope, and disables the button instead of letting the click end in
// the host's refusal. A list not read yet blocks nothing: the refusal
// still stands behind it. The broadcast keeps the list live, so a
// mount need not re-ask (as in useOtherHostMirrors).
export function useLocalMirrorBlocker(): string | undefined {
  const query = useQuery({
    queryKey: queryKeys.mirrors(),
    queryFn: () => window.api.mirror.list(),
    select: (list) => mirrorEngineBlocker(list.daemon),
    enabled: hasLocalHost,
    staleTime: 30_000,
    meta: { silentError: true },
  });
  return query.data;
}

// The same for "Mirror here" on a peer's page, whose session runs on
// that peer (the scope): its daemon must be up, and this device must
// accept commands, since the peer sends the copy here through them.
export function useMirrorHereBlocker(peerLabel: string): string | undefined {
  const { api, keys } = useHostScope();
  const engine = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    select: (list) => mirrorEngineBlocker(list.daemon, peerLabel),
    staleTime: 30_000,
    meta: { silentError: true },
  });
  const accepts = useAcceptsCommands();
  if (accepts.data === false) {
    return `A mirror runs on the device holding the original, so ${peerLabel} sends the copy here, and this device doesn't accept commands. Turn command access on from this device's Devices page.`;
  }
  return engine.data;
}

// One device's mirror:changed written into that device's list entry,
// by the boot watchers. The broadcast carries the list, so it is
// written with no round trip: a busy mirror fires several times a
// second. An in-flight read is cancelled first, or its older answer
// would land on top. An older host sends no list, and that one is
// re-asked.
export function writeMirrorList(
  queryClient: QueryClient,
  deviceId: string,
  list: MirrorListResult | undefined,
): void {
  const queryKey = queryKeysFor(deviceId).mirrors();
  if (list === undefined) {
    void queryClient.invalidateQueries({ queryKey });
    return;
  }
  void queryClient.cancelQueries({ queryKey });
  queryClient.setQueryData(queryKey, list);
}

// A mirrored pair as the sidebar folds it: the peer's row (device,
// worktree) that folds into a local row, and the peer device the local
// row wears. A session pairs its local original with the peer's copy.
// A served stream pairs the served copy with the peer's original, when
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

// The pairs a peer's list adds for the scoped device: the sessions
// that peer runs against the scoped device's worktrees. A paused or
// disconnected session serves no stream here, so the served set alone
// would unfold the pair exactly while it needs attention.
function peerMirrorLinksOf(
  peerDeviceId: string,
  scopedDeviceId: string,
  mirrors: MirrorListResult,
): MirrorLink[] {
  return mirrors.sessions
    .filter((session) => session.deviceId === scopedDeviceId)
    .map((session) => ({
      peerDeviceId,
      peerWorktreeId: session.localWorktreeId,
      localWorktreeId: session.worktreeId,
    }));
}

// The pairs alone, for the always-mounted sidebar: the scoped device's
// own projection and every other host's, merged. The lists move on
// every cycle of a busy mirror (counts, status), and each projection
// stays referentially the same through all of that (react-query
// shares an unchanged select result structurally), so the merge, a
// pure function of them the compiler memoizes, does too, and the rows
// are not rebuilt for news they do not show. With nothing to add from
// the others, the own projection is returned as is.
export function useMirrorLinks(): MirrorLink[] {
  const { api, keys, hasHost, deviceId } = useHostScope();
  const query = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    select: mirrorLinksOf,
    enabled: hasHost,
  });
  const others = useOtherHostMirrors(deviceId, (list, peerDeviceId) =>
    peerMirrorLinksOf(peerDeviceId, deviceId, list),
  );
  const own = query.data ?? NO_LINKS;
  if (others.every((other) => (other.data?.length ?? 0) === 0)) return own;
  const seen = new Set(own.map(linkKey));
  const links = [...own];
  for (const other of others) {
    for (const link of other.data ?? NO_LINKS) {
      const key = linkKey(link);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }
  return links;
}

// The one mirror picture a worktree row cares about: the session this
// device runs ON it (it is the original of a copy made on a peer), and
// the streams this device serves FROM it (it is a peer's copy).
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

// Every other host's mirror picture, projected by `select`: this
// machine's (when the scope is a peer's) and the peers with a session
// up. The scoped device's own list is useMirrors. Each list is kept
// live by its device's broadcast at boot, so this only reads. A peer
// with no session up (asleep, or still dialing) is listed with no
// data even when its last list is still cached: a session it stopped
// meanwhile would otherwise show for as long as it stays away. The
// projections come combined with their ids. react-query shares an
// unchanged select result structurally, and the combined array too,
// so both keep their references through cycles that change nothing
// they show.
function useOtherHostMirrors<T>(
  exceptDeviceId: string,
  select: (list: MirrorListResult, deviceId: string) => T,
): { deviceId: string; api: HostApi | undefined; data: T | undefined }[] {
  const devices = useHostDevices();
  const candidates = [
    ...(hasLocalHost ? [{ deviceId: localDeviceId, api: window.api }] : []),
    ...devices.map((device) => ({
      deviceId: device.deviceId,
      api: device.api,
    })),
  ].filter((candidate) => candidate.deviceId !== exceptDeviceId);
  return useQueries({
    queries: candidates.map(({ deviceId, api }) =>
      queryOptions<MirrorListResult, Error, T>({
        queryKey: queryKeysFor(deviceId).mirrors(),
        queryFn: api === undefined ? skipToken : () => api.mirror.list(),
        select: (list) => select(list, deviceId),
        // The broadcast writes every change in, so a mount need not
        // re-ask each peer. The session-landed sweep refetches after a
        // blip (invalidateDeviceSession).
        staleTime: 30_000,
        meta: { silentError: true },
      }),
    ),
    combine: (results) =>
      results.map((result, index) => {
        const { deviceId, api } = candidates[index];
        return {
          deviceId,
          api,
          data: api === undefined ? undefined : (result.data as T | undefined),
        };
      }),
  });
}

// A mirror the worktree is part of, seen from its page: the device
// that RUNS it (where the controls go), the other party as this page
// sees it, and the session document, which is the runner's. The
// session is absent while only the stream this device serves says a
// peer mirrors the worktree (the runner's list not yet read, or an
// older runner whose list a peer cannot read).
export type WorktreeMirrorLink = {
  runnerDeviceId: string;
  // Undefined while the runner is a peer with no session up: nothing
  // to drive the session through.
  runnerApi: HostApi | undefined;
  otherDeviceId: string;
  session: MirrorSession | undefined;
};

// The mirrors a worktree is part of, seen from its page on whichever
// device: the session the scoped device runs ON it (it is the
// original), and one link per other device running a session AGAINST
// it (it is the copy), whose session lives on that device. Those are found off every connected device's list, not off
// the streams the scoped device serves: a paused or disconnected
// session serves no stream, and that is exactly when the far end
// wants to resume it. A page at the far end of a mirror gets its
// controls this way: the manage dialog mounts under the runner's
// scope, and the same hooks that drive a local session drive the
// peer's.
export function useWorktreeMirrorLinks(
  worktree: Worktree,
): WorktreeMirrorLink[] {
  const scope = useHostScope();
  const { session: own, serving } = useWorktreeMirror(worktree);
  const others = useOtherHostMirrors(scope.deviceId, (list) =>
    list.sessions.find(
      (s) => s.deviceId === scope.deviceId && s.worktreeId === worktree.id,
    ),
  );
  const links: WorktreeMirrorLink[] = [];
  if (own !== undefined) {
    links.push({
      runnerDeviceId: scope.deviceId,
      runnerApi: scope.api,
      otherDeviceId: own.deviceId,
      session: own,
    });
  }
  for (const { deviceId, api, data: session } of others) {
    if (session !== undefined) {
      links.push({
        runnerDeviceId: deviceId,
        runnerApi: api,
        otherDeviceId: deviceId,
        session,
      });
    }
  }
  for (const stream of serving) {
    if (links.some((link) => link.runnerDeviceId === stream.peerDeviceId)) {
      continue;
    }
    links.push({
      runnerDeviceId: stream.peerDeviceId,
      runnerApi: undefined,
      otherDeviceId: stream.peerDeviceId,
      session: undefined,
    });
  }
  return links;
}

// Start a mirror, driven by the mirror dialog: a send and the session
// opened on top, on the device holding the original. "Mirror to…"
// sends one of this device's. "Mirror here" asks the peer the dialog
// is scoped to, which holds the original, to send it here, the clone
// place (when this device has no checkout) in this device's terms.
// The dialog's last step is the report, so no toast here. Refusals
// surface centrally. The cancel goes to the device running the start:
// the peer for "Mirror here", this device for "Mirror to…".
export function useStartMirror(move: Move) {
  const { api } = useHostScope();
  return useMoveMutation(move, {
    cancel: (sourceWorktreeId) =>
      move.direction === "pull"
        ? api.sync.cancelMove({ sourceWorktreeId })
        : window.api.sync.cancelMove({ sourceWorktreeId }),
    pull: ({
      sourceProjectId,
      sourceWorktreeId,
      runSetup,
      ignoreMode,
      ignores,
      cloneInto,
    }) =>
      api.mirror.startTo({
        targetDeviceId: localDeviceId,
        projectId: sourceProjectId,
        worktreeId: sourceWorktreeId,
        runSetup,
        ignoreMode,
        ignores,
        cloneInto,
      }),
    send: (payload) => window.api.mirror.startTo(payload),
  });
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

// Changing what a running mirror leaves out, on the device running it
// (the scope's, see useMirrorControls). The list refreshes off the
// daemon's snapshot.
export function useSetMirrorIgnores() {
  const { api } = useHostScope();
  return useMutation({
    mutationFn: (input: { session: string } & MirrorIgnoreChoice) =>
      api.mirror.setIgnores(input),
    onError: (err) =>
      notifyError("Couldn't change what the mirror leaves out", err),
    meta: { silentError: true },
  });
}

// The session's controls, on the device running it: the scope these
// are mounted under (the manage dialog re-scopes itself to the runner,
// so a page at the far end drives the session through the peer). The
// list refreshes off that daemon's own state snapshot.
export function useMirrorControls() {
  const { api } = useHostScope();
  const queryClient = useQueryClient();
  // Stop removes the copy with the session: the runner's peer, the
  // session's remote side, which may be this machine. A copy here the
  // renderer forgets the way a delete does. A copy elsewhere is that
  // device's view to refresh.
  const stop = useMutation({
    mutationFn: ({
      session,
      force,
    }: {
      session: MirrorSession;
      force?: boolean;
    }) => api.mirror.stop(session.session, force),
    onSuccess: (_data, { session }) => {
      if (session.deviceId === localDeviceId) {
        forgetDeletedWorktree(
          queryClient,
          localDeviceId,
          session.projectId,
          session.worktreeId,
        );
      } else {
        invalidateHostDevice(queryClient, session.deviceId);
      }
    },
    onError: (err) => notifyError("Couldn't stop mirroring", err),
    meta: { silentError: true },
  });
  const pause = useMutation({
    mutationFn: (session: string) => api.mirror.pause(session),
    onError: (err) => notifyError("Couldn't pause mirroring", err),
    meta: { silentError: true },
  });
  const resume = useMutation({
    mutationFn: (session: string) => api.mirror.resume(session),
    onError: (err) => notifyError("Couldn't resume mirroring", err),
    meta: { silentError: true },
  });
  return { stop, pause, resume };
}
