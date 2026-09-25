// Tracks per-worktree lifecycle state the host broadcasts: the
// in-flight create phase (so the detail page can show a banner:
// carrying over / setting up / provisioning ports, and the carry-over
// failure toast can fire after the IPC has already returned), and a
// removal under way, so a worktree on its way out reads as deleting
// to every window and not only to the one that pressed the button (a
// mirror stop, a transplant's source teardown, the CLI's unmirror all
// remove through the same host delete). One store per device, like
// the script run stores: the create phases stream to the caller, so
// only this machine's store sees them, while a peer's store carries
// the peer's removals. Main is the source of truth. A store only
// reflects the events its device broadcasts.
import { useSyncExternalStore } from "react";
import type { CreatePhase, WorktreeRemoval } from "@shared/schemas";
import { localDeviceId } from "@/lib/queryKeys";
import {
  apiFor,
  onAccountLeft,
  onSessionLanded,
} from "@/lib/remote/remoteDeviceSync";
import { toast } from "@/lib/toast";
import type { RendererApi } from "@/window";
import { KeyedSubscribers } from "./keyedSubscribers";

export type { CreatePhase } from "@shared/schemas";

// The phase as the detail page's banner reads it. The pull dialogs
// word the same phases as steps of their own run (transplant/
// PullProgress.tsx rows, pullSteps.ts headlines).
export const CREATE_PHASE_LABEL = {
  carryOver: "Carrying over files...",
  setup: "Setting up...",
  portPoolProvision: "Provisioning ports...",
} satisfies Record<CreatePhase, string>;

type WorktreesApi = Pick<
  RendererApi["worktrees"],
  "onLifecyclePhase" | "onCarryOverComplete" | "onRemoval"
>;

interface StartDeps {
  // Fired when main auto-removed manual carry-over entries because
  // .worktreeinclude now covers them, so caches over project.json can be
  // invalidated.
  onCarryOverReconciled?: (projectId: string) => void;
}

function clippedLines(lines: string[], max: number): string {
  const shown = lines.slice(0, max);
  const more = lines.length - shown.length;
  return shown.join("\n") + (more > 0 ? `\n...and ${more} more` : "");
}

// Followers of a removal on any device, with the announcing device:
// the boot gives an announced removal the treatment this window's own
// delete gives its worktree (cancel its fetches, then drop its row and
// queries once it is gone). Boot-scoped, so there is no unsubscribe.
type RemovalListener = (deviceId: string, removal: WorktreeRemoval) => void;
const removalListeners = new Set<RemovalListener>();

export function onWorktreeRemoval(listener: RemovalListener): void {
  removalListeners.add(listener);
}

class WorktreeLifecycleStore {
  private phases = new Map<string, CreatePhase>();
  private removing = new Set<string>();
  private subs = new KeyedSubscribers<string>();
  private unsubscribes: Array<() => void> = [];
  private deviceId: string;
  private api: WorktreesApi;

  constructor(deviceId: string, api: WorktreesApi) {
    this.deviceId = deviceId;
    this.api = api;
  }

  // The local store is a renderer-lifetime singleton whose
  // subscriptions are never torn down (their presence doubles as the
  // already-started guard). A peer's store goes with the account. A
  // peer's store follows removals only: the create stream reaches its
  // caller alone, so nothing else would ever arrive.
  start(deps?: StartDeps): void {
    if (this.unsubscribes.length > 0) return;
    this.unsubscribes.push(
      this.api.onRemoval((removal) => {
        if (removal.state === "removing") {
          if (this.removing.has(removal.worktreeId)) return;
          this.removing.add(removal.worktreeId);
        } else {
          if (!this.removing.delete(removal.worktreeId)) return;
        }
        this.subs.notify(removal.worktreeId);
        for (const listener of removalListeners) {
          listener(this.deviceId, removal);
        }
      }),
    );
    if (this.deviceId !== localDeviceId) return;
    this.unsubscribes.push(
      this.api.onLifecyclePhase((evt) => {
        this.setPhase(evt.worktreeId, evt.phase === "idle" ? null : evt.phase);
      }),
      this.api.onCarryOverComplete((evt) => {
        const removed = evt.removedCarryOverPaths ?? [];
        if (removed.length > 0) {
          deps?.onCarryOverReconciled?.(evt.projectId);
          toast.info(
            `.worktreeinclude replaced ${removed.length} carry-over ${
              removed.length === 1 ? "entry" : "entries"
            }`,
            {
              description:
                "The repo's .worktreeinclude file now covers these paths, so " +
                "their manual carry-over entries were removed:\n" +
                clippedLines(removed, 4),
            },
          );
        }
        const { applied, failures } = evt.report;
        const includeFailures = evt.report.includeFailures ?? [];
        if (includeFailures.length > 0) {
          toast.warning("Couldn't resolve .worktreeinclude", {
            description: clippedLines(
              includeFailures.map((f) =>
                f.source ? `${f.source}: ${f.reason}` : f.reason,
              ),
              4,
            ),
          });
        }
        const sourced = evt.report.sourced ?? [];
        if (sourced.length > 0) {
          toast.info("Carried over from other worktrees", {
            description: clippedLines(
              sourced.map(
                (s) =>
                  `${s.path} from ${s.source}${
                    s.copiedInstead
                      ? " (copied: symlinks only target the main checkout)"
                      : ""
                  }`,
              ),
              4,
            ),
          });
        }
        if (failures.length === 0) return;
        toast.warning(
          `Carried over ${applied} of ${applied + failures.length} entries`,
          {
            description: clippedLines(
              failures.map(
                (f) =>
                  `${f.path}${f.source ? ` in ${f.source}` : ""}: ${f.reason}`,
              ),
              4,
            ),
          },
        );
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    this.phases.clear();
    this.clearRemoving();
  }

  // The wire may drop between a removal's start and its close, and
  // the close is not replayed. A session landing again refetches the
  // device's listing (the session-landed sweep), which then says
  // whether the worktree is still there. The flag is not to outlive
  // that.
  clearRemoving(): void {
    const ids = [...this.removing];
    this.removing.clear();
    for (const id of ids) this.subs.notify(id);
  }

  subscribe(worktreeId: string, cb: () => void): () => void {
    return this.subs.subscribe(worktreeId, cb);
  }

  phase(worktreeId: string): CreatePhase | null {
    return this.phases.get(worktreeId) ?? null;
  }

  isRemoving(worktreeId: string): boolean {
    return this.removing.has(worktreeId);
  }

  private setPhase(worktreeId: string, phase: CreatePhase | null): void {
    if (phase === null) {
      if (!this.phases.delete(worktreeId)) return;
    } else {
      if (this.phases.get(worktreeId) === phase) return;
      this.phases.set(worktreeId, phase);
    }
    this.subs.notify(worktreeId);
  }
}

// `start()` is called by the renderer entry point so subscription
// lifecycle has a single owner. Importing this module just constructs
// the singleton; it does not attach IPC listeners as a side effect.
export const worktreeLifecycle = new WorktreeLifecycleStore(
  localDeviceId,
  window.api.worktrees,
);

// A peer's stores, dropped with the account like the script run
// stores. One listens from the moment the peer's session lands, not
// from the first row that asks: the row a mirror folds away is never
// rendered, so nothing would open the store before the peer announces
// the copy's removal, and a broadcast is not replayed.
const peerStores = new Map<string, WorktreeLifecycleStore>();

onAccountLeft(() => {
  for (const store of peerStores.values()) store.stop();
  peerStores.clear();
});

onSessionLanded((deviceId) => {
  worktreeLifecycleFor(deviceId).clearRemoving();
});

function worktreeLifecycleFor(deviceId: string): WorktreeLifecycleStore {
  if (deviceId === localDeviceId) return worktreeLifecycle;
  let store = peerStores.get(deviceId);
  if (store === undefined) {
    store = new WorktreeLifecycleStore(deviceId, apiFor(deviceId).worktrees);
    store.start();
    peerStores.set(deviceId, store);
  }
  return store;
}

// Null asks for nothing: a page whose worktree lives on a peer has no
// local create lifecycle to follow.
export function useWorktreeCreatePhase(
  worktreeId: string | null,
): CreatePhase | null {
  return useSyncExternalStore(
    (cb) =>
      worktreeId === null
        ? () => {}
        : worktreeLifecycle.subscribe(worktreeId, cb),
    () => (worktreeId === null ? null : worktreeLifecycle.phase(worktreeId)),
    () => null,
  );
}

// Whether the device is in the middle of removing the worktree, as
// its host announced it. `deviceId` names the peer a remote row or
// page belongs to, or this machine.
export function useWorktreeRemoving(
  worktreeId: string,
  deviceId: string,
): boolean {
  const store = worktreeLifecycleFor(deviceId);
  return useSyncExternalStore(
    (cb) => store.subscribe(worktreeId, cb),
    () => store.isRemoving(worktreeId),
    () => false,
  );
}
