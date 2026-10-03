// The branch's remote-sync action(s) as drawn (WorktreeSyncPill.tsx
// runs them): Publish, Push N, Pull N, Pull and push, or the diverged
// pair. Nothing when synced or detached.
import { ArrowDown, ArrowUp, CloudUpload } from "lucide-react";
import { pluralize } from "@/lib/pluralize";
import type { deriveRemoteSyncState } from "@shared/schemas";
import { SyncActionButton } from "./SyncActionButton";

export type SyncAction =
  | "publish"
  | "push"
  | "pull"
  | "pullAndPush"
  | "pushForce"
  | "overwrite";

type RemoteSyncState = ReturnType<typeof deriveRemoteSyncState>;

const noop = () => undefined;
const NONE = {};

export function WorktreeSyncPillView({
  state,
  autoPull,
  pending = NONE,
  armed = NONE,
  on = NONE,
}: {
  state: RemoteSyncState;
  // Whether auto-pull is on, which the pull's title explains.
  autoPull: boolean;
  pending?: Partial<Record<SyncAction, boolean>>;
  // The diverged pair's two-step confirms.
  armed?: { pushForce?: boolean; overwrite?: boolean };
  on?: Partial<Record<SyncAction, () => void>>;
}) {
  if (state.kind === "detached" || state.kind === "synced") return null;

  if (state.kind === "publish") {
    return (
      <SyncActionButton
        tone="violet"
        icon={CloudUpload}
        label="Publish branch"
        title={
          state.canPublish
            ? "Push branch to remote with upstream tracking"
            : "No git remote is configured for this project"
        }
        disabled={!state.canPublish}
        pending={pending.publish ?? false}
        onClick={on.publish ?? noop}
      />
    );
  }

  if (state.kind === "ahead") {
    return (
      <SyncActionButton
        tone="emerald"
        icon={ArrowUp}
        label={`Push ${pluralize(state.ahead, "commit")}`}
        title="git push"
        pending={pending.push ?? false}
        onClick={on.push ?? noop}
      />
    );
  }

  if (state.kind === "behind") {
    return (
      <SyncActionButton
        tone="sky"
        icon={ArrowDown}
        label={`Pull ${pluralize(state.behind, "commit")}`}
        title={
          autoPull
            ? "git pull --ff-only. Auto-pull is on: the app fast-forwards after its next fetch, as long as the worktree has no uncommitted changes or running script."
            : "git pull --ff-only"
        }
        pending={pending.pull ?? false}
        onClick={on.pull ?? noop}
      />
    );
  }

  if (state.kind === "pullAndPush") {
    return (
      <SyncActionButton
        tone="indigo"
        label={`Pull and push ↑${state.ahead}↓${state.behind}`}
        title="git pull --rebase, falling back to a merge on conflict, then git push"
        pending={pending.pullAndPush ?? false}
        onClick={on.pullAndPush ?? noop}
      />
    );
  }

  // Histories have truly diverged. The only moves left are "overwrite the
  // remote" (force-push) or "overwrite local" (reset hard), both behind a
  // two-step confirm.
  // pull --rebase would almost certainly fail mid-flight here, so we don't
  // offer it. The user picks which side wins.
  const busy = (pending.pushForce ?? false) || (pending.overwrite ?? false);
  return (
    <span
      title={`Diverged: ${state.ahead} local, ${state.behind} remote. History has split. Pick which side wins.`}
      className="inline-flex shrink-0 items-center gap-1 self-center text-xs"
    >
      <span className="px-1.5 text-rose-500">Overwrite:</span>
      <SyncActionButton
        tone="rose"
        icon={ArrowUp}
        label={armed.pushForce ? "Confirm?" : `Push ${state.ahead}`}
        title={
          armed.pushForce
            ? "Click again to confirm"
            : "git push --force-with-lease (overwrites the remote)"
        }
        pending={pending.pushForce ?? false}
        disabled={busy}
        onClick={on.pushForce ?? noop}
      />
      <SyncActionButton
        tone="rose"
        icon={ArrowDown}
        label={armed.overwrite ? "Confirm?" : `Pull ${state.behind}`}
        title={
          armed.overwrite
            ? "Click again to confirm"
            : "git fetch && git reset --hard @{u} (overwrites local)"
        }
        pending={pending.overwrite ?? false}
        disabled={busy}
        onClick={on.overwrite ?? noop}
      />
    </span>
  );
}
