// Continuous worktree mirroring, renderer side. The list is
// host-scoped (a device's mirrors and the streams it serves are its
// own facts), read through the surrounding scope's api. Every device's
// list is kept live by its own mirror:changed broadcast, through its
// push watch (lib/hostWatch.ts), so nothing here subscribes. A mirror
// runs on the device holding the original: the start is a send plus a
// mirror on that device's daemon, this machine's for "Mirror to", the
// peer's for "Mirror here" (asked through this device's startFrom,
// which invites it past this device's own switch). The controls (stop, pause, resume, the
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
  isMirrorCopyStayed,
  isMirrorStopUnconfirmed,
  type MirrorDaemonStatus,
  mirrorEngineBlocker,
  type MirrorEvent,
  type MirrorListResult,
  type MirrorSession,
  type MirrorServing,
} from "@shigomori/contracts/modules/mirror";
import type { Worktree } from "@shigomori/contracts/schemas";
import { type HostApi, useHostScope } from "@/hooks/remote/useHostScope";
import {
  type MirrorIgnoreChoice,
  type Move,
  useMoveMutation,
} from "@/hooks/remote/useMoveWorktree";
import { quietVillagerMoves } from "@/lib/villagers/moves";
import {
  useEveryHost,
  useRemoteDeviceApi,
} from "@/hooks/remote/useRemoteDevices";
import { hasLocalHost } from "@/lib/localHost";
import {
  invalidateHostDevice,
  localDeviceId,
  queryKeys,
  queryKeysFor,
} from "@/lib/queryKeys";
import { forgetDeletedWorktree } from "@/hooks/worktrees/useWorktreeMutations";
import { notifyError, toast } from "@/lib/toast";

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
// that peer (the scope): its daemon must be up. This device's own
// switch is not in the way: the ask invites the mirror, and the peer's
// send lands here through the invitation (host/mirror/invites.ts).
export function useMirrorHereBlocker(peerLabel: string): string | undefined {
  const { api, keys } = useHostScope();
  const engine = useQuery({
    queryKey: keys.mirrors(),
    queryFn: () => api.mirror.list(),
    select: (list) => mirrorEngineBlocker(list.daemon, peerLabel),
    staleTime: 30_000,
    meta: { silentError: true },
  });
  return engine.data;
}

// One device's mirror:changed written into that device's list entry,
// by the boot watchers. The broadcast carries the list, so it is
// written with no round trip: a busy mirror fires several times a
// second. An in-flight read is cancelled first, or its older answer
// would land on top. A host sends none when it has no daemon yet or
// its list failed to build or to validate (host/ipc/modules/mirror.ts
// currentMirrorList, main/ipc/handlers.ts), and that one is re-asked.
export function writeMirrorList(
  queryClient: QueryClient,
  deviceId: string,
  list: MirrorListResult | undefined,
): void {
  const queryKey = queryKeysFor(deviceId).mirrors();
  if (list === undefined) {
    void queryClient.invalidateQueries({ queryKey, exact: true });
    return;
  }
  // Exact: the history thread's key sits under the list's, and a
  // cancel by prefix would cancel its read in flight too, leaving the
  // panel on its skeleton.
  void queryClient.cancelQueries({ queryKey, exact: true });
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

function mirrorLinksOf(mirrors: MirrorListResult): MirrorLink[] {
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
function useWorktreeMirror(worktree: Worktree): {
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
// machine's (when the scope is a peer's) and every peer that hosts
// projects. The scoped device's own list is useMirrors. Each list is
// kept live by its device's broadcast at boot, so this only reads. A
// peer with no session up (asleep, or still dialing) keeps its last
// list, marked unreachable: the mirror it runs is still there as far
// as anyone here can know, and dropping it would make its copy here
// read as unmirrored exactly while its runner is away (the pair
// unfolded, the start buttons back, no way to see the mirror). The
// session's own state is the runner's last word, which the surfaces
// say is stale. The projections come combined with their ids.
// react-query shares an unchanged select result structurally, and the
// combined array too, so both keep their references through cycles
// that change nothing they show.
function useOtherHostMirrors<T>(
  exceptDeviceId: string | undefined,
  select: (list: MirrorListResult, deviceId: string) => T,
): {
  deviceId: string;
  api: HostApi | undefined;
  data: T | undefined;
}[] {
  const candidates = useEveryHost().filter(
    (candidate) => candidate.deviceId !== exceptDeviceId,
  );
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
      candidates.map(({ deviceId, api }, index) => ({
        deviceId,
        api,
        data: results[index]?.data as T | undefined,
      })),
  });
}

// Every host's mirror picture, this machine's included, for the Live
// page and the sidebar's Live mark: the same reads as the others above
// (the broadcasts keep each one live), with no device left out.
export function useEveryHostMirrors(): {
  deviceId: string;
  api: HostApi | undefined;
  data: MirrorListResult | undefined;
}[] {
  return useOtherHostMirrors(undefined, (list) => list);
}

// A mirror the worktree is part of, seen from its page: the device
// that RUNS it (where the controls go), the other party as this page
// sees it, and the session document, which is the runner's. The
// session is absent while only the stream this device serves says a
// peer mirrors the worktree (the runner's list not yet read, or an
// older runner whose list a peer cannot read).
// Where a side of a mirror is: its worktree, in its project.
export type MirrorCopyAt = { projectId: string; worktreeId: string };

export type WorktreeMirrorLink = {
  runnerDeviceId: string;
  // Undefined while the runner is a peer with no session up: nothing
  // to drive the session through, and the session is its last word.
  runnerApi: HostApi | undefined;
  otherDeviceId: string;
  // The other device's copy of the worktree, where its page is. Off
  // the session, so undefined while only a served stream says so (a
  // stream names the peer's worktree but not its project).
  otherCopy: MirrorCopyAt | undefined;
  session: MirrorSession | undefined;
  // The runner's engine, as its list last said (a restarting engine
  // lists its last sessions).
  engine: MirrorDaemonStatus;
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
  const { daemon } = useMirrors();
  const { session: own, serving } = useWorktreeMirror(worktree);
  // A peer's page read off its cache while it is away: its own session
  // is its last word too.
  const scopeApi = useRemoteDeviceApi(
    scope.remote ? scope.deviceId : undefined,
  );
  const others = useOtherHostMirrors(scope.deviceId, (list) => {
    const session = list.sessions.find(
      (s) => s.deviceId === scope.deviceId && s.worktreeId === worktree.id,
    );
    return session === undefined ? undefined : { session, engine: list.daemon };
  });
  const links: WorktreeMirrorLink[] = [];
  if (own !== undefined) {
    links.push({
      runnerDeviceId: scope.deviceId,
      runnerApi: scope.remote && scopeApi === undefined ? undefined : scope.api,
      otherDeviceId: own.deviceId,
      otherCopy: { projectId: own.projectId, worktreeId: own.worktreeId },
      session: own,
      engine: daemon,
    });
  }
  for (const { deviceId, api, data } of others) {
    if (data !== undefined) {
      links.push({
        runnerDeviceId: deviceId,
        runnerApi: api,
        otherDeviceId: deviceId,
        otherCopy:
          data.session.localWorktreeId === ""
            ? undefined
            : {
                projectId: data.session.localProjectId,
                worktreeId: data.session.localWorktreeId,
              },
        session: data.session,
        engine: data.engine,
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
      otherCopy: undefined,
      session: undefined,
      engine: "running",
    });
  }
  return links;
}

// Start a mirror, driven by the mirror dialog: a send and the session
// opened on top, on the device holding the original. "Mirror to…"
// sends one of this device's. "Mirror here" runs this device's
// mirror:startFrom, which invites the mirror and asks the peer the
// dialog is scoped to, which holds the original, to send it here, the
// clone place (when this device has no checkout) in this device's
// terms. The dialog's last step is the report, so no toast here.
// Refusals surface centrally. Either start is a move this device runs,
// so the cancel is the ordinary one, which startFrom forwards to the
// peer running the send.
export function useStartMirror(move: Move) {
  return useMoveMutation(move, {
    cancel: (sourceWorktreeId) =>
      window.api.sync.cancelMove({ sourceWorktreeId }),
    pull: ({
      sourceDeviceId,
      sourceProjectId,
      sourceWorktreeId,
      sourceIdentity,
      runSetup,
      ignoreMode,
      ignores,
      cloneInto,
    }) =>
      window.api.mirror.startFrom({
        sourceDeviceId,
        sourceProjectId,
        sourceWorktreeId,
        sourceIdentity,
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
// The broadcast carries the list alone, so the thread is re-read on a
// slow beat while it is on screen.
export function useMirrorHistory(localWorktreeId: string) {
  const { api, keys } = useHostScope();
  return useQuery<readonly MirrorEvent[]>({
    queryKey: keys.mirrorHistory(localWorktreeId),
    queryFn: async () => (await api.mirror.history({ localWorktreeId })).events,
    refetchInterval: 5_000,
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
  // The outcome is said here and not by the dialog, which may be gone
  // by then: the session leaves the list (and the dialog with it) as
  // the copy goes. A refusal for want of confirmation is the dialog's
  // to show, in place, beside what it would take.
  const stop = useMutation({
    mutationFn: ({
      session,
      force,
    }: {
      session: MirrorSession;
      force?: boolean;
      // The copy's device by name, for the words.
      copyName: string;
    }) => {
      // Its copy going is the mirror stopping, not its villager leaving.
      quietVillagerMoves([session.worktreeId]);
      return api.mirror.stop({ session: session.session, force });
    },
    onSuccess: (result, { copyName }) => {
      toast.success(
        result?.removedCopy === false
          ? `Mirror stopped. The original is gone, so the copy on ${copyName} stays.`
          : `Mirror stopped. The copy on ${copyName} is removed.`,
      );
    },
    onError: (error, { copyName }) => {
      if (isMirrorStopUnconfirmed(error)) return;
      if (isMirrorCopyStayed(error)) {
        notifyError(
          `Mirror stopped, but the copy on ${copyName} couldn't be removed. Delete it from its page.`,
        );
        return;
      }
      notifyError("Couldn't stop mirroring", error);
    },
    onSettled: (result, error, { session }) => {
      // A copy that stayed was still the mirror stopping.
      if (error !== null && !isMirrorCopyStayed(error)) return;
      const removed = error === null && result?.removedCopy !== false;
      if (removed && session.deviceId === localDeviceId) {
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
    meta: { silentError: true },
  });
  const pause = useMutation({
    mutationFn: (session: string) => api.mirror.pause({ session }),
    onError: (err) => notifyError("Couldn't pause mirroring", err),
    meta: { silentError: true },
  });
  const resume = useMutation({
    mutationFn: (session: string) => api.mirror.resume({ session }),
    onError: (err) => notifyError("Couldn't resume mirroring", err),
    meta: { silentError: true },
  });
  return { stop, pause, resume };
}
