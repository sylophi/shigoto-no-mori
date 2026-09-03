// Step 3 of the transplant: proof it landed, then the one decision the
// old one-shot transplant made for the user -- what happens to the
// copy still on the source device. Keep leaves it, shelve hides it
// (the peer's ordinary setShelved, files kept), tear down runs the
// same guarded teardown the one-shot orchestrator did
// (sync:teardownSource). Shelve is preselected: the work is here now,
// the source copy is only a fallback, and shelving throws nothing away.
import { ArrowRight, Check } from "lucide-react";
import { useState } from "react";
import type { SyncPullWorktreeResult } from "@shared/ipc/modules/sync";
import type { Project, Worktree } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { PathSpan } from "@/components/ui/path-span";
import { RowTag } from "@/components/ui/row-tag";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  keptSourceReason,
  useTeardownSource,
} from "@/hooks/remote/useBringWorktreeHere";
import { LocalHostScope } from "@/hooks/remote/useHostScope";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import {
  CONFIRM_DESTRUCTIVE_MS,
  useConfirmTwice,
} from "@/hooks/ui/useConfirmTwice";
import { useSetShelved } from "@/hooks/worktrees/useWorktreeMutations";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { TransplantBody, TransplantFooter } from "./TransplantChrome";

type SourceChoice = "keep" | "shelve" | "teardown";

// The three fates of the source copy, in card order. Shelve is
// preselected when the work landed whole: the source copy is then only
// a fallback, and shelving throws nothing away. With the changes
// stranded on the source, keep is the default instead: hiding the only
// copy of that work is not what "recommended" should mean.
const CHOICES: {
  key: SourceChoice;
  title: string;
  body: (source: string) => string;
}[] = [
  {
    key: "keep",
    title: "Keep it",
    body: () => "Both devices keep a checkout of this branch.",
  },
  {
    key: "shelve",
    title: "Shelve it",
    body: () => "Hidden from the sidebar there, files kept. Unshelve any time.",
  },
  {
    key: "teardown",
    title: "Tear it down",
    body: (source) => `Runs teardown and removes it from ${source} for good.`,
  },
];

const FINISH_LABEL: Record<SourceChoice, string> = {
  keep: "Keep and finish",
  shelve: "Shelve and finish",
  teardown: "Tear down and finish",
};

export function TransplantFinish({
  result,
  worktree,
  project,
  sourceDeviceLabel,
  thisDeviceLabel,
  onClose,
  onOpen,
}: {
  result: SyncPullWorktreeResult;
  // The SOURCE worktree and project, on the remote device this page is
  // scoped to. The landed local pair is in `result`.
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  onClose: () => void;
  // Leave for the landed worktree's own page, on this machine.
  onOpen: () => void;
}) {
  const setShelved = useSetShelved();
  const teardown = useTeardownSource({ worktree, sourceProjectId: project.id });
  const {
    armed,
    trigger,
    reset: disarm,
  } = useConfirmTwice(CONFIRM_DESTRUCTIVE_MS);
  // An unapplied capture means the uncommitted work exists only on the
  // source, so tearing it down is off the table (the handler refuses
  // it too. This is the reason, spelled out).
  const stranded = result.captured && !result.dirtyApplied;
  const [choice, setChoiceState] = useState<SourceChoice>(
    stranded ? "keep" : "shelve",
  );
  const choose = (next: SourceChoice) => {
    // Neither an armed confirm nor a stale failure carries over from
    // one choice to another.
    disarm();
    setShelved.reset();
    teardown.reset();
    setChoiceState(next);
  };
  const pending = setShelved.isPending || teardown.isPending;
  const error = setShelved.error ?? teardown.error;
  // A teardown that resolved without removing the source: the dialog
  // stays, with the reason, so the user can fix it and try again or
  // pick another fate.
  const kept =
    teardown.data !== undefined && !teardown.data.sourceRemoved
      ? (keptSourceReason(teardown.data.sourceError) ??
        "its teardown was refused.")
      : null;
  const branch = result.worktree.branch;

  // Each fate ends on the landed worktree's page, except a teardown
  // the source refused.
  const finish = async () => {
    try {
      if (choice === "shelve") {
        await setShelved.mutateAsync({
          projectId: project.id,
          worktreeId: worktree.id,
          shelved: true,
        });
        toast.success(`Transplanted ${branch} here`, {
          description: `The copy on ${sourceDeviceLabel} is shelved.`,
        });
      } else if (choice === "teardown") {
        const outcome = await teardown.mutateAsync();
        if (!outcome.sourceRemoved) return;
        toast.success(`Transplanted ${branch} here`, {
          description: `The copy on ${sourceDeviceLabel} was torn down.`,
        });
      } else {
        toast.success(`Brought ${branch} here`, {
          description: `The copy on ${sourceDeviceLabel} is kept.`,
        });
      }
      onOpen();
    } catch {
      // Reported inline below (and by the hook's own error title).
    }
  };

  const onFinish = () => {
    if (choice === "teardown") trigger(() => void finish());
    else void finish();
  };

  return (
    <>
      <TransplantBody>
        <div className="flex flex-col gap-5">
          <section className="space-y-2">
            <SectionHeading>Ready on {thisDeviceLabel}</SectionHeading>
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-500/10 p-3">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-background"
              >
                <Check className="size-4" />
              </span>
              <div className="min-w-0 flex-1 basis-64 space-y-1.5">
                <p className="truncate font-mono text-sm font-semibold">
                  {branch}
                </p>
                <LocalHostScope>
                  <LandedPath path={result.worktree.path} />
                </LocalHostScope>
                <div className="flex flex-wrap gap-1.5">
                  {result.captured ? (
                    result.dirtyApplied ? (
                      <Chip>changes re-applied</Chip>
                    ) : (
                      <Chip className="text-amber-700 dark:text-amber-300">
                        changes stayed on {sourceDeviceLabel}
                      </Chip>
                    )
                  ) : (
                    <Chip>clean tree</Chip>
                  )}
                </div>
              </div>
              <Button size="sm" onClick={onOpen} className="shrink-0">
                Open here
                <ArrowRight />
              </Button>
            </div>
            {stranded && (
              <p className="text-xs text-muted-foreground">
                The uncommitted changes could not be applied here. They are
                still on {sourceDeviceLabel}, and the capture is parked for{" "}
                <span className="font-mono">sm dirty apply</span>.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <SectionHeading>
              The copy still on {sourceDeviceLabel}
            </SectionHeading>
            <div
              role="radiogroup"
              aria-label={`What to do with the copy on ${sourceDeviceLabel}`}
              className="grid gap-2 sm:grid-cols-3"
            >
              {CHOICES.map((entry) => {
                const off = entry.key === "teardown" && stranded;
                return (
                  <ChoiceCard
                    key={entry.key}
                    selected={choice === entry.key}
                    onSelect={() => choose(entry.key)}
                    disabled={off}
                    title={entry.title}
                    badge={
                      entry.key === "shelve" && !stranded
                        ? "recommended"
                        : undefined
                    }
                    body={
                      off
                        ? "Off while the changes only exist there."
                        : entry.body(sourceDeviceLabel)
                    }
                    tone={entry.key === "teardown" && !off ? "rose" : undefined}
                  />
                );
              })}
            </div>
          </section>

          {error !== null ? (
            <p className="text-xs text-destructive select-text">
              {isCommandRefusedError(error)
                ? peerReadOnlyNote(sourceDeviceLabel)
                : errorMessageOf(error)}
            </p>
          ) : (
            kept !== null && (
              <p className="text-xs text-destructive select-text">
                The copy on {sourceDeviceLabel} stayed: {kept}
              </p>
            )
          )}
        </div>
      </TransplantBody>

      <TransplantFooter
        note={`You can change this later from the worktree's page on ${sourceDeviceLabel}.`}
      >
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          Decide later
        </Button>
        <Button
          size="sm"
          variant={choice === "teardown" ? "destructive" : "default"}
          aria-pressed={choice === "teardown" ? armed : undefined}
          disabled={pending}
          onClick={onFinish}
        >
          {pending
            ? "Finishing…"
            : armed && choice === "teardown"
              ? "Click again to confirm"
              : FINISH_LABEL[choice]}
        </Button>
      </TransplantFooter>
    </>
  );
}

function ChoiceCard({
  selected,
  disabled = false,
  onSelect,
  title,
  badge,
  body,
  tone,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  badge?: string;
  body: string;
  // The destructive option carries its own warning colour on its
  // title, selected or not.
  tone?: "rose";
}) {
  return (
    <button
      type="button"
      role="radio"
      data-slot="choice-card"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3 text-left text-xs transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        selected
          ? "border-primary/40 bg-accent text-accent-foreground"
          : "border-border bg-card hover:bg-muted/50",
        disabled && "cursor-not-allowed opacity-50 hover:bg-card",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full",
            selected
              ? "bg-primary text-primary-foreground"
              : "bg-muted-foreground/20",
          )}
        >
          {selected && <Check className="size-2.5" />}
        </span>
        <span
          className={cn(
            "text-sm font-medium",
            tone === "rose" && "text-rose-600 dark:text-rose-400",
          )}
        >
          {title}
        </span>
        {badge && (
          <span className="ml-auto">
            <RowTag>{badge}</RowTag>
          </span>
        )}
      </span>
      <span className={cn(!selected && "text-muted-foreground")}>{body}</span>
    </button>
  );
}

// The landed path, tildified against this machine's home (the ready
// card sits inside the remote page's scope, hence the local re-pin).
function LandedPath({ path }: { path: string }) {
  const { data: runtime } = useRuntimeInfo();
  return (
    <PathSpan
      path={path}
      home={runtime?.homedir ?? null}
      className="min-w-0 truncate font-mono text-xs text-muted-foreground"
      copyable
    />
  );
}
