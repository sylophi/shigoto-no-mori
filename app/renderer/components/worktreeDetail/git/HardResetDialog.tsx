import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Warning } from "@/components/ui/warning";
import { ModalShell } from "@/components/ui/modal-shell";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import {
  useMergePreview,
  useResetHard,
  useUndoResetHard,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import { toast, UNDO_TOAST_MS } from "@/lib/toast";
import type { MergePreview, Worktree } from "@shared/schemas";

// `git reset --hard` to any branch or commit, saying first what the
// branch loses and gains. What it throws away, commits and uncommitted
// files alike, comes back with the toast's Undo. The History tab opens
// on where the branch landed. `initialRef` is the commit a commit's
// menu opened it on.
export function HardResetDialog({
  worktree,
  initialRef = "",
  onClose,
}: {
  worktree: Worktree;
  initialRef?: string;
  onClose: () => void;
}) {
  const nav = useWorktreeNav();
  const { projectId, id: worktreeId, branch } = worktree;
  const [ref, setRef] = useState(initialRef);
  const preview = useMergePreview(worktree, ref, true);
  const { data: operation } = useWorktreeOperation(worktree);
  const reset = useResetHard();
  const undo = useUndoResetHard();
  const data = preview.data;
  const dirty = worktree.changedCount > 0;
  const blocked =
    operation?.operation != null
      ? `Finish or abort the ${operation.operation} first.`
      : null;
  const ready =
    data !== undefined &&
    (data.incoming > 0 || data.own > 0 || dirty) &&
    blocked === null &&
    !reset.isPending;

  const submit = () => {
    if (!ready) return;
    // Pinned to the HEAD the preview counted from.
    const expectHead = worktree.recentCommits[0]?.hash;
    reset.mutate(
      { projectId, worktreeId, ref, expectHead },
      {
        onSuccess: ({ previousHead, head, snapshot, worktree: after }) => {
          onClose();
          // The page's own hash for it, which the History list marks.
          nav.toCommit(
            projectId,
            worktreeId,
            after.recentCommits[0]?.hash ?? head,
            true,
          );
          toast(`Hard reset ${branch} to ${ref}`, {
            duration: UNDO_TOAST_MS,
            action: {
              label: "Undo",
              onClick: () =>
                undo.mutate({
                  projectId,
                  worktreeId,
                  previousHead,
                  at: head,
                  snapshot,
                }),
            },
          });
        },
      },
    );
  };

  return (
    // Held open while the reset runs: closed, its failure would go
    // unsaid.
    <ModalShell
      onClose={() => {
        if (!reset.isPending) onClose();
      }}
      popoverClassName="max-w-md"
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SimpleTooltip whenTruncated tip={branch}>
          <h2 className="truncate text-base font-semibold">
            Hard reset <span className="font-mono">{branch}</span>
          </h2>
        </SimpleTooltip>
        <div className="space-y-1.5">
          <label htmlFor="reset-to" className="block text-xs font-medium">
            To
          </label>
          <BranchCombobox
            id="reset-to"
            projectId={projectId}
            value={ref}
            onChange={(next) => {
              setRef(next);
              reset.reset();
            }}
            placeholder="Select a branch or commit…"
            excludeBranches={[branch]}
            pinnedBranch={worktree.primaryRef}
          />
        </div>
        <Outcome
          branch={branch}
          ref_={ref}
          dirty={dirty}
          preview={data}
          error={preview.error}
        />
        {reset.error ? (
          <Warning>
            <InlineError
              multiline
              title="Couldn't hard reset"
              message={reset.error.message}
            />
          </Warning>
        ) : (
          blocked !== null && <Warning>{blocked}</Warning>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={reset.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="destructive"
            size="sm"
            disabled={!ready}
          >
            Hard reset
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

// Where the branch goes, in a line, and what it leaves behind.
function Outcome({
  branch,
  ref_: ref,
  dirty,
  preview,
  error,
}: {
  branch: string;
  ref_: string;
  dirty: boolean;
  preview: MergePreview | undefined;
  error: Error | null;
}) {
  if (ref !== "" && error) {
    return (
      <Warning>
        <InlineError
          multiline
          title="Couldn't compare"
          message={error.message}
        />
      </Warning>
    );
  }
  let line: string;
  if (ref === "") line = "Pick where to move the branch.";
  else if (!preview) line = `Comparing with ${ref}…`;
  else line = describe(branch, ref, preview);
  const unpushed = preview && notOnARemote(preview);
  return (
    <div className="space-y-1.5 text-sm">
      <p>{line}</p>
      {unpushed && <Warning>{unpushed}</Warning>}
      {preview && dirty && (
        <Warning>Your uncommitted changes are thrown away</Warning>
      )}
    </div>
  );
}

// Which of the commits a hard reset drops no remote has, which the
// toast's Undo is then the only easy way back to.
function notOnARemote({ own, pushed }: MergePreview): string | null {
  const unpushed = own - pushed;
  if (unpushed === 0) return null;
  if (own === 1) return "It isn't on a remote";
  if (unpushed === own) return "None of them are on a remote";
  return `${unpushed} of them ${unpushed === 1 ? "isn't" : "aren't"} on a remote`;
}

function describe(
  branch: string,
  ref: string,
  { incoming, own }: MergePreview,
): string {
  if (own === 0 && incoming === 0) return `${branch} is already at ${ref}.`;
  if (own === 0) {
    return `Moves ${branch} forward to ${ref}, ${pluralize(incoming, "commit")} on.`;
  }
  const dropping = `dropping ${pluralize(own, "commit")}`;
  if (incoming === 0) return `Moves ${branch} back to ${ref}, ${dropping}.`;
  return `Moves ${branch} over to ${ref}, ${dropping} and taking on ${pluralize(incoming, "commit")}.`;
}
