import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { ModalShell } from "@/components/ui/modal-shell";
import { formatBytes } from "@/lib/formatBytes";
import type { TidySummary } from "./tidyModel";
import { TidyVerdictBadge } from "./TidyVerdictBadge";

interface TidyConfirmProps {
  summary: TidySummary;
  deleteBranches: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// The last thing between a click and an irreversible removal. Everything
// that is about to happen is spelled out here by name: which worktrees,
// why each one was picked, and how much comes back. When the selection
// includes anything the page would not have ticked itself, the confirm
// button stays disabled behind an explicit acknowledgement.
export function TidyConfirm({
  summary,
  deleteBranches,
  onCancel,
  onConfirm,
}: TidyConfirmProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  const { selected, risky, projectCount, reclaimBytes, reclaimPartial } =
    summary;
  const count = selected.length;
  const blocked = risky.length > 0 && !acknowledged;

  return (
    <ModalShell onClose={onCancel} popoverClassName="max-w-lg">
      <div className="p-5">
        <h2 className="text-base font-semibold">
          Remove {count} {count === 1 ? "worktree" : "worktrees"}
          {/* Named up front: a selection reaching into several repos is a
              bigger act than tidying the one you were looking at. */}
          {projectCount > 1 && ` across ${projectCount} projects`}?
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Each one&apos;s directory is deleted from disk along with everything
          inside it — node_modules, build output, and any file that was never
          committed. Teardown scripts run first
          {deleteBranches ? ", and the local branch is deleted too" : ""}. This
          cannot be undone.
        </p>

        <ul className="mt-4 max-h-56 space-y-2 overflow-y-auto">
          {selected.map((entry) => (
            <li
              key={entry.worktree.id}
              className="flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium select-text">
                    <span className="font-normal text-muted-foreground">
                      {entry.project.name}
                    </span>
                    <span aria-hidden className="px-1 text-muted-foreground/60">
                      /
                    </span>
                    {entry.worktree.name}
                  </span>
                  <TidyVerdictBadge kind={entry.verdict.kind} />
                </div>
                <span className="truncate text-xs text-muted-foreground">
                  {entry.verdict.reason}
                </span>
              </div>
              <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                {entry.disk ? formatBytes(entry.disk.bytes) : "—"}
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-sm">
          Frees{" "}
          <span className="font-medium">
            {reclaimPartial ? "at least " : ""}
            {formatBytes(reclaimBytes)}
          </span>
          .
        </p>

        {risky.length > 0 && (
          <ErrorBanner className="mt-3">
            <p className="text-[11px] font-semibold tracking-wide uppercase">
              Unsaved work will be destroyed
            </p>
            <p className="mt-2 leading-relaxed">
              {risky.length} of these {risky.length === 1 ? "is" : "are"} not
              safe to remove:{" "}
              {risky
                .map((entry) => `${entry.project.name}/${entry.worktree.name}`)
                .join(", ")}
              . Their changes exist nowhere else.
            </p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={() => setAcknowledged((prev) => !prev)}
                className="size-3.5 shrink-0 accent-destructive"
              />
              I understand this work will be lost
            </label>
          </ErrorBanner>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- focus the safe action so a stray Enter cancels
            autoFocus
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={blocked}
            onClick={onConfirm}
          >
            Remove {count} {count === 1 ? "worktree" : "worktrees"}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
