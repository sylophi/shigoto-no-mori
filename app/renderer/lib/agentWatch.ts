// The agent sessions in every device's worktree lists, the same lists
// the sidebar shows, read off the cache like the villagers' moves
// (lib/villagers/moves.ts): this machine's reach it through the fs
// watcher's refetch and a peer's through its pushes. From them, the
// worktrees whose agent waits on you (useWaitingAgents, for the Live
// page and its mark), and on the desktop a system notification when a
// session starts waiting on you or ends its turn.
//
// A notification goes out only while the window is in the background,
// where the sidebar's mark can't be seen, and a list seen for the first
// time (or again after it failed or left the cache) tells nothing:
// nothing changed that this window saw.
import type { QueryClient } from "@tanstack/react-query";
import type { AgentSession, ClientConfig, Worktree } from "@shared/schemas";
import { clientConfigQueryOptions } from "@/hooks/config/useClientConfig";
import { needView } from "@/lib/agentNeeds";
import { harnessLabel } from "@/lib/agentSessions";
import { documentFocused } from "@/lib/focus";
import { hasLocalHost } from "@/lib/localHost";
import { hostKeyDeviceId, isWorktreeListKey } from "@/lib/queryKeys";
import { fillRoutePath, WORKTREE_ROUTE_PATHS } from "@/lib/routePaths";
import { createExternalStore, useExternalStore } from "@/store/externalStore";

// An agent session waiting on you, in a worktree on any device.
export type WaitingAgent = {
  deviceId: string;
  projectId: string;
  worktreeId: string;
  session: AgentSession;
};

// Each list as last seen, by query hash: the list itself (structural
// sharing hands back the same one when nothing changed), its sessions
// by worktree and session, and its worktrees waiting on you.
const lastSeen = new Map<
  string,
  {
    list: Worktree[];
    sessions: Map<string, AgentSession>;
    waiting: WaitingAgent[];
  }
>();

// Every list's sessions waiting on you, longest wait first.
const waitingStore = createExternalStore<WaitingAgent[]>([]);

export function useWaitingAgents(): WaitingAgent[] {
  return useExternalStore(waitingStore);
}

function publishWaiting(): void {
  waitingStore.publish(
    [...lastSeen.values()]
      .flatMap((seen) => seen.waiting)
      .toSorted((a, b) => a.session.at - b.session.at),
  );
}

// Boot wiring, once per window, like the other boot subscriptions.
export function startAgentWatch(queryClient: QueryClient): void {
  queryClient.getQueryCache().subscribe((event) => {
    const { queryKey, queryHash } = event.query;
    if (!isWorktreeListKey(queryKey)) return;
    if (
      event.type === "removed" ||
      (event.type === "updated" && event.action.type === "error")
    ) {
      if (lastSeen.delete(queryHash)) publishWaiting();
      return;
    }
    if (event.type !== "updated" || event.action.type !== "success") return;
    const list = event.query.state.data as Worktree[] | undefined;
    const before = lastSeen.get(queryHash);
    if (list === undefined || list === before?.list) return;
    const deviceId = String(hostKeyDeviceId(queryKey));
    const sessions = new Map<string, AgentSession>();
    const waiting: WaitingAgent[] = [];
    const notices: Notice[] = [];
    // Read once per list, and only where a notice could go out.
    const config =
      before !== undefined && hasLocalHost && !documentFocused()
        ? (queryClient.getQueryData<ClientConfig>(
            clientConfigQueryOptions.queryKey,
          ) ?? {})
        : undefined;
    for (const worktree of list) {
      for (const now of worktree.agentSessions ?? []) {
        if (now.state === "waiting") {
          waiting.push({
            deviceId,
            projectId: worktree.projectId,
            worktreeId: worktree.id,
            session: now,
          });
        }
        const key = `${worktree.id}\u0000${now.harness}:${now.session}`;
        sessions.set(key, now);
        if (config === undefined) continue;
        const notice = noticeFor(before?.sessions.get(key), now, config);
        if (notice) notices.push({ ...notice, worktree, deviceId });
      }
    }
    lastSeen.set(queryHash, { list, sessions, waiting });
    publishWaiting();
    for (const notice of notices) notify(notice);
  });
}

type Notice = {
  title: string;
  body: string;
  worktree: Worktree;
  deviceId: string;
};

function notify({ title, body, worktree, deviceId }: Notice): void {
  void window.api.window.notify({
    title,
    body: [worktree.title ?? worktree.name, body].filter(Boolean).join("\n"),
    route: fillRoutePath(WORKTREE_ROUTE_PATHS.detail, {
      deviceId,
      projectId: worktree.projectId,
      worktreeId: worktree.id,
    }),
  });
}

// What a session's change is news of, if anything: it started waiting
// on you (or on something else than before), or a turn ended. A state
// that changed and came back between two reads of the list still
// counts, by when it last changed.
function noticeFor(
  before: AgentSession | undefined,
  now: AgentSession,
  config: ClientConfig,
): { title: string; body: string } | null {
  if (
    now.state === "waiting" &&
    config.notifyAgentWaiting !== false &&
    (before?.state !== "waiting" ||
      before.at !== now.at ||
      before.tool !== now.tool ||
      before.need !== now.need)
  ) {
    const { sentence, text } = needView(now);
    return { title: sentence, body: text ?? "" };
  }
  if (
    now.state === "idle" &&
    before !== undefined &&
    (before.state !== "idle" || before.at !== now.at) &&
    config.notifyAgentDone === true
  ) {
    return {
      title: `${harnessLabel(now.harness)} finished`,
      body: now.message ?? "",
    };
  }
  return null;
}
