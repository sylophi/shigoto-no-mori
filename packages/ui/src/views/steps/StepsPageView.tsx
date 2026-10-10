// The one page the window shows in place of the app while the app gets
// itself ready: the v3 migration's and a fresh install's first run.
// Each flow's container picks its steps; the page, the rows, the
// progress line and the button are the same for both. No words but the
// step names: the marks and the counts say the rest.
import { Children, type ReactNode } from "react";
import { AlertTriangle, Check, FolderGit2, TreeDeciduous } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
import {
  type StatusTone,
  TONE_FILL,
  TONE_MARK,
} from "../../primitives/status-dot.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { cn } from "../../lib/utils.ts";

export type StepState = "waiting" | "running" | "done" | "stuck";

const TONE: Record<StepState, StatusTone> = {
  waiting: "slate",
  running: "sky",
  done: "emerald",
  stuck: "amber",
};

export function StepsPageView({
  title,
  children,
  footer,
}: {
  title: string;
  // The rows.
  children: ReactNode;
  // What ends the page by hand (the migration's Continue past a stuck
  // step).
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-3 px-3">
          <TreeDeciduous className="size-6 text-muted-foreground/70" />
          <h1 className="text-xl font-medium tracking-tight">{title}</h1>
        </div>
        <ol className="space-y-1">{children}</ol>
        {footer !== undefined && (
          <div className="mt-6 flex justify-end px-3">{footer}</div>
        )}
      </div>
    </div>
  );
}

export function StepRowView({
  label,
  state,
  trailing,
  children,
}: {
  label: string;
  state: StepState;
  // At the row's end: a count, or the button a step waits on.
  trailing?: ReactNode;
  // Under the row: the progress line, what is stuck, a picker.
  children?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "rounded-lg px-3 py-2",
        state === "running" && TONE_FILL.sky,
        state === "stuck" && TONE_FILL.amber,
      )}
    >
      <div className="flex min-h-7 items-center gap-3 text-sm">
        <StepMarkView state={state} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            state === "waiting" && "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {trailing}
      </div>
      {Children.toArray(children).length > 0 && (
        <div className="mt-2 space-y-2 pl-7">{children}</div>
      )}
    </li>
  );
}

function StepMarkView({ state }: { state: StepState }) {
  const word = <span className="sr-only">{state}</span>;
  if (state === "done" || state === "stuck") {
    const Icon = state === "done" ? Check : AlertTriangle;
    return (
      <span className={cn("flex size-4 shrink-0", TONE_MARK[TONE[state]])}>
        <Icon aria-hidden className="m-auto size-3.5" />
        {word}
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className="relative flex size-4 shrink-0">
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full bg-sky-500/40"
        />
        <span
          aria-hidden
          className="relative m-auto size-2 rounded-full bg-sky-500"
        />
        {word}
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0">
      <span
        aria-hidden
        className="m-auto size-2 rounded-full bg-muted-foreground/30"
      />
      {word}
    </span>
  );
}

// A step's count, at the row's end.
export function StepCountView({
  done,
  total,
}: {
  done: number;
  total: number;
}) {
  return (
    <span className="tabular shrink-0 text-xs text-muted-foreground">
      {done} of {total}
    </span>
  );
}

// How far a step is, and what it is on now.
export function StepProgressView({
  done,
  total,
  current,
}: {
  done: number;
  total: number;
  current: string | null;
}) {
  const share = total === 0 ? 0 : Math.min(done / total, 1);
  return (
    <div className="space-y-1.5">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-sky-500 transition-[width]"
          style={{ width: `${share * 100}%` }}
        />
      </div>
      {current !== null && (
        <SimpleTooltip whenTruncated tip={current}>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {current}
          </div>
        </SimpleTooltip>
      )}
    </div>
  );
}

// What a step couldn't do, one line each: the item, and why.
export function StepStuckView({
  items,
}: {
  items: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map(({ name, reason }) => (
        <li key={name}>
          <SimpleTooltip whenTruncated tip={`${name}: ${reason}`}>
            <div className="truncate text-xs">
              <span className="font-mono">{name}</span>
              <span className="ml-2 text-muted-foreground">{reason}</span>
            </div>
          </SimpleTooltip>
        </li>
      ))}
    </ul>
  );
}

// The button a step waits on, or the page's own.
export function StepActionView({
  label,
  pending = false,
  onClick,
}: {
  label: string;
  pending?: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" disabled={pending} onClick={onClick}>
      {label}
    </Button>
  );
}

// The sign-in, the same step in both flows: a button while it waits on
// the person, and its mark alone while it goes by itself.
export function SignInStepView({
  state,
  asks,
  onSignIn,
}: {
  state: StepState;
  asks: boolean;
  onSignIn: () => void;
}) {
  return (
    <StepRowView
      label="Sign in"
      state={state}
      trailing={
        asks && (
          <StepActionView
            label="Continue with GitHub"
            pending={state === "running"}
            onClick={onSignIn}
          />
        )
      }
    />
  );
}

// Repos to add from a list the device already keeps (terrier's), one
// click each.
export function StepRepoChoicesView({
  repos,
  pending,
  onPick,
}: {
  repos: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  // The repo being added.
  pending: string | null;
  onPick: (path: string) => void;
}) {
  return (
    <ul className="max-h-40 overflow-y-auto">
      {repos.map(({ name, path }) => (
        <li key={path}>
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => onPick(path)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50 dark:hover:bg-muted/50"
          >
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0">{name}</span>
            <SimpleTooltip whenTruncated tip={path}>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {path}
              </span>
            </SimpleTooltip>
          </button>
        </li>
      ))}
    </ul>
  );
}
