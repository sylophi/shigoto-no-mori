import { ArrowDown, ArrowUp, CloudUpload, Loader2 } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import {
  useOverwriteWorktree,
  usePublishWorktree,
  usePullAndPushWorktree,
  usePullWorktree,
  usePushForceWorktree,
  usePushWorktree,
} from "@/hooks/useWorktrees";
import { deriveRemoteSyncState, type Worktree } from "@shared/schemas";

interface WorktreeSyncPillProps {
  worktree: Worktree;
}

// Renders the remote-sync action(s) for a worktree. Returns null in the
// states where there's nothing to show (synced, detached) so the header
// stays quiet -- the caller takes care of the dirty-state pill, which is
// mutually exclusive with this one.
export function WorktreeSyncPill({ worktree }: WorktreeSyncPillProps) {
  const state = deriveRemoteSyncState(worktree);
  const input = { projectId: worktree.projectId, worktreeId: worktree.id };

  const push = usePushWorktree();
  const pull = usePullWorktree();
  const pushForce = usePushForceWorktree();
  const overwrite = useOverwriteWorktree();
  const publish = usePublishWorktree();
  const pullAndPush = usePullAndPushWorktree();

  if (state.kind === "detached" || state.kind === "synced") return null;

  if (state.kind === "publish") {
    return (
      <SingleAction
        tone="violet"
        icon={CloudUpload}
        label="Publish"
        title={
          state.canPublish
            ? "Push branch to remote with upstream tracking"
            : "No git remote is configured for this project"
        }
        disabled={!state.canPublish}
        pending={publish.isPending}
        onClick={() => publish.mutate(input)}
      />
    );
  }

  if (state.kind === "ahead") {
    return (
      <SingleAction
        tone="emerald"
        icon={ArrowUp}
        label={`Push ${commitsLabel(state.ahead)}`}
        title="git push"
        pending={push.isPending}
        onClick={() => push.mutate(input)}
      />
    );
  }

  if (state.kind === "behind") {
    return (
      <SingleAction
        tone="sky"
        icon={ArrowDown}
        label={`Pull ${commitsLabel(state.behind)}`}
        title="git pull --ff-only"
        pending={pull.isPending}
        onClick={() => pull.mutate(input)}
      />
    );
  }

  if (state.kind === "pullAndPush") {
    return (
      <SingleAction
        tone="indigo"
        label={`Pull and push ↑${state.ahead}↓${state.behind}`}
        title="git pull --rebase && git push"
        pending={pullAndPush.isPending}
        onClick={() => pullAndPush.mutate(input)}
      />
    );
  }

  // Histories have truly diverged. The only safe pre-confirmed moves are
  // "overwrite the remote" (force-push) or "overwrite local" (reset hard).
  // pull --rebase would almost certainly fail mid-flight here, so we don't
  // offer it -- the user picks which side wins.
  const busy = pushForce.isPending || overwrite.isPending;
  return (
    <span
      title={`Diverged: ${state.ahead} local, ${state.behind} remote. History has split -- pick which side wins.`}
      className="inline-flex shrink-0 items-center gap-1 self-center text-xs"
    >
      <span className="px-1.5 text-rose-500">Overwrite:</span>
      <SingleAction
        tone="rose"
        icon={ArrowUp}
        label={`Push ${state.ahead}`}
        title="git push --force-with-lease -- overwrites the remote"
        pending={pushForce.isPending}
        disabled={busy}
        onClick={() => pushForce.mutate(input)}
      />
      <SingleAction
        tone="rose"
        icon={ArrowDown}
        label={`Pull ${state.behind}`}
        title="git fetch && git reset --hard @{u} -- overwrites local"
        pending={overwrite.isPending}
        disabled={busy}
        onClick={() => overwrite.mutate(input)}
      />
    </span>
  );
}

type Tone = "violet" | "emerald" | "sky" | "indigo" | "rose";

// Tone-to-class lookup. Spelled out so Tailwind's JIT keeps the classes
// in the build instead of pruning the dynamic interpolation.
const TONE_CLASSES: Record<Tone, string> = {
  violet:
    "text-violet-500 hover:bg-violet-500/10 focus-visible:outline-violet-500",
  emerald:
    "text-emerald-500 hover:bg-emerald-500/10 focus-visible:outline-emerald-500",
  sky: "text-sky-500 hover:bg-sky-500/10 focus-visible:outline-sky-500",
  indigo:
    "text-indigo-500 hover:bg-indigo-500/10 focus-visible:outline-indigo-500",
  rose: "text-rose-500 hover:bg-rose-500/10 focus-visible:outline-rose-500",
};

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

interface SingleActionProps {
  tone: Tone;
  icon?: IconType;
  label: string;
  title: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function SingleAction({
  tone,
  icon: Icon,
  label,
  title,
  pending,
  disabled,
  onClick,
}: SingleActionProps) {
  const DisplayIcon = pending ? Loader2 : Icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      title={title}
      className={cn(
        "tabular inline-flex shrink-0 items-center gap-1 self-center rounded-md px-1.5 py-1 text-xs transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
        TONE_CLASSES[tone],
      )}
    >
      {label}
      {DisplayIcon && (
        <DisplayIcon
          aria-hidden
          className={cn("size-3.5", pending && "animate-spin")}
        />
      )}
    </button>
  );
}

function commitsLabel(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}
