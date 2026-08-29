// The transplant confirmation, shaped after the owner's flow mockups
// but honest to the backend: sync:transplantWorktree is one invoke, so
// the dialog has a review step, a pending step, and a done step — no
// invented per-phase progress. Review says exactly what travels and
// what happens; done reports where the worktree landed and whether the
// source was torn down (a kept source is a partial success with its
// reason, never an error). The move itself is the shared bring-here
// mutation, quieted: the steps below are the report.
import { useState } from "react";
import { ArrowRight, Check, Loader2, Shovel } from "lucide-react";
import { isCommandRefusedError } from "@shared/ipc/socket/frames";
import type { SyncTransplantWorktreeResult } from "@shared/ipc/modules/sync";
import type { Worktree } from "@shared/schemas";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { StatusDot } from "@/components/ui/status-dot";
import {
  keptSourceReason,
  useBringWorktreeHere,
} from "@/hooks/remote/useBringWorktreeHere";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { errorMessageOf } from "@shared/errors";

export function TransplantDialog({
  worktree,
  sourceProjectId,
  sourceIdentity,
  sourceDeviceLabel,
  localProjectId,
  onClose,
}: {
  worktree: Worktree;
  sourceProjectId: string;
  sourceIdentity: string;
  sourceDeviceLabel: string;
  localProjectId: string;
  onClose: () => void;
}) {
  const nav = useWorktreeNav();
  // The shared bring-here mutation, quiet: this dialog's done state is
  // the report, so the hook's toasts would say it twice.
  const transplant = useBringWorktreeHere({
    worktree,
    sourceProjectId,
    sourceIdentity,
    localProjectId,
    transplant: true,
    quiet: true,
  });
  // The hook's result is the pull/transplant union; `transplant: true`
  // only ever resolves the transplant arm, and narrowing it once here
  // keeps the done body typed.
  const [result, setResult] = useState<SyncTransplantWorktreeResult>();

  const start = () => {
    void transplant
      .mutateAsync()
      .then((landed) => {
        if ("sourceRemoved" in landed) setResult(landed);
      })
      .catch(() => {
        // Surfaces in the error line below (refusals toast centrally).
      });
  };

  const pending = transplant.isPending;

  return (
    <ModalShell onClose={onClose} closeOnEscape={!pending}>
      <div className="flex flex-col gap-4 p-5">
        <header className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md bg-accent p-1.5 text-muted-foreground">
            {result ? (
              <Check className="size-4" />
            ) : (
              <Shovel className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-medium">
              {result ? "Transplant complete" : "Transplant worktree"}
            </h2>
            <p className="text-xs text-muted-foreground">
              {result ? (
                <>
                  <span className="font-mono">{worktree.branch}</span> now lives
                  on this machine.
                </>
              ) : (
                <>
                  Move <span className="font-mono">{worktree.branch}</span> off{" "}
                  {sourceDeviceLabel}, uncommitted work and carry-over files
                  included.
                </>
              )}
            </p>
          </div>
        </header>

        {result ? (
          <DoneBody
            result={result}
            sourceDeviceLabel={sourceDeviceLabel}
            onOpen={() => {
              onClose();
              // The landed worktree is local, so leave the remote scope
              // behind explicitly rather than through the scoped nav.
              nav.toLocalWorktree(
                result.worktree.projectId,
                result.worktree.id,
              );
            }}
            onClose={onClose}
          />
        ) : (
          <>
            <div className="space-y-2 rounded-md border border-border p-3 text-xs">
              <div className="flex items-center gap-2">
                <StatusDot tone="emerald" />
                <span className="font-medium">{sourceDeviceLabel}</span>
                <span className="text-muted-foreground">·</span>
                <span className="truncate font-mono text-muted-foreground">
                  {worktree.path}
                </span>
              </div>
              <p className="text-muted-foreground">
                {worktree.changedCount > 0
                  ? `${worktree.changedCount} uncommitted ${
                      worktree.changedCount === 1 ? "file" : "files"
                    } travel with the branch.`
                  : "The tree is clean — only the branch and its history travel."}
                {worktree.ahead > 0 &&
                  ` ${worktree.ahead} unpushed ${
                    worktree.ahead === 1 ? "commit comes" : "commits come"
                  } along too.`}
              </p>
            </div>

            <ol className="space-y-1.5 text-xs text-muted-foreground">
              <Step n={1}>
                Capture the uncommitted changes on {sourceDeviceLabel}, index
                untouched.
              </Step>
              <Step n={2}>
                Move the branch and its history here over the device link.
              </Step>
              <Step n={3}>
                Create the worktree on this machine, carry-over applied.
              </Step>
              <Step n={4}>
                Tear the source down — only once everything landed. If anything
                can&apos;t land, the copy on {sourceDeviceLabel} stays
                untouched.
              </Step>
            </ol>

            {transplant.isError && !isCommandRefusedError(transplant.error) && (
              <p className="text-xs text-destructive select-text">
                {errorMessageOf(transplant.error)}
              </p>
            )}

            <footer className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button size="sm" disabled={pending} onClick={start}>
                {pending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Transplanting…
                  </>
                ) : (
                  <>
                    Start transplant
                    <ArrowRight />
                  </>
                )}
              </Button>
            </footer>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[9px] text-muted-foreground">
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function DoneBody({
  result,
  sourceDeviceLabel,
  onOpen,
  onClose,
}: {
  result: SyncTransplantWorktreeResult;
  sourceDeviceLabel: string;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="space-y-1.5 rounded-md border border-border p-3 text-xs">
        <div className="flex items-center gap-2">
          <StatusDot tone="emerald" />
          <span className="font-mono">{result.worktree.branch}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate font-mono text-muted-foreground">
            {result.worktree.path}
          </span>
        </div>
        <p className="text-muted-foreground">
          {result.captured && !result.dirtyApplied
            ? `The uncommitted changes could not be applied here — they are still safe on ${sourceDeviceLabel}.`
            : result.sourceRemoved
              ? `Uncommitted changes came along, and the copy on ${sourceDeviceLabel} was torn down.`
              : `The copy on ${sourceDeviceLabel} stayed: ${
                  keptSourceReason(result.sourceError) ??
                  "its teardown was refused."
                }`}
        </p>
      </div>
      <footer className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" onClick={onOpen}>
          Open worktree
          <ArrowRight />
        </Button>
      </footer>
    </>
  );
}
