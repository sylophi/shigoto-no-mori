import { useState, type ReactNode } from "react";
import { Check, GitMerge, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Input } from "@/components/ui/input";
import { ModalShell } from "@/components/ui/modal-shell";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { BranchCombobox } from "@/components/shared/BranchCombobox";
import { useWorktreeSuccessToast } from "@/hooks/villagers/useWorktreeSuccessToast";
import {
  useMergeBranch,
  useMergePreview,
  useWorktreeOperation,
} from "@/hooks/worktrees/useGitHistory";
import { useWorktreeNav } from "@/hooks/worktrees/useWorktreeNav";
import { pluralize } from "@/lib/pluralize";
import type { IntegrateMethod, MergePreview, Worktree } from "@shared/schemas";

// How many conflicted files the dialog names before it counts the rest.
const NAMED_CONFLICTS = 3;

const METHODS: { value: IntegrateMethod; label: string }[] = [
  { value: "merge", label: "Merge" },
  { value: "squash", label: "Squash" },
  { value: "rebase", label: "Rebase" },
  { value: "fastForward", label: "Fast-forward" },
];

// The Git page's way to bring another branch in, opening the dialog.
export function MergeButton({ worktree }: { worktree: Worktree }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
        <GitMerge />
        Merge
      </Button>
      {open && (
        <MergeDialog worktree={worktree} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// Another branch's work into this one, the four ways git has, each
// saying what it will do before it runs: how many commits come in, and
// which files would conflict. A merge, squash or rebase that conflicts
// stops for the Changes tab to settle, where the banner continues it.
// Otherwise the History tab opens on what it made.
function MergeDialog({
  worktree,
  onClose,
}: {
  worktree: Worktree;
  onClose: () => void;
}) {
  const nav = useWorktreeNav();
  const say = useWorktreeSuccessToast();
  const { projectId, id: worktreeId, branch } = worktree;
  const [ref, setRef] = useState(
    worktree.primaryRef !== undefined && !worktree.isPrimary
      ? worktree.primaryRef
      : "",
  );
  const [picked, setPicked] = useState<IntegrateMethod | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const preview = useMergePreview(worktree, ref);
  const { data: operation } = useWorktreeOperation(worktree);
  const merge = useMergeBranch();
  const data = preview.data;
  // Until one is picked: a fast-forward where the branch has nothing of
  // its own, a merge otherwise.
  const method = picked ?? (data?.own === 0 ? "fastForward" : "merge");
  const squashMessage = message ?? data?.incomingSubject ?? "";
  const blocked =
    operation?.operation != null
      ? `Finish or abort the ${operation.operation} first.`
      : worktree.changedCount > 0
        ? "Commit or stash your changes first."
        : null;
  const ready =
    data !== undefined &&
    data.incoming > 0 &&
    !(method === "fastForward" && data.own > 0) &&
    !(method === "squash" && squashMessage.trim() === "") &&
    blocked === null &&
    !merge.isPending;

  const submit = () => {
    if (!ready) return;
    merge.mutate(
      {
        projectId,
        worktreeId,
        ref,
        method,
        message: method === "squash" ? squashMessage.trim() : undefined,
      },
      {
        onSuccess: ({ worktree: after, stopped }) => {
          onClose();
          if (stopped) {
            nav.toDiff(projectId, worktreeId, { replace: true });
            return;
          }
          say(after, DONE[method](ref));
          const head = after.recentCommits[0]?.hash;
          if (head) nav.toCommit(projectId, worktreeId, head, true);
        },
      },
    );
  };

  return (
    <ModalShell onClose={onClose} popoverClassName="max-w-md">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SimpleTooltip whenTruncated tip={branch}>
          <h2 className="truncate text-base font-semibold">
            Merge into <span className="font-mono">{branch}</span>
          </h2>
        </SimpleTooltip>
        <div className="space-y-1.5">
          <label htmlFor="merge-from" className="block text-xs font-medium">
            From
          </label>
          <BranchCombobox
            id="merge-from"
            projectId={projectId}
            value={ref}
            onChange={(next) => {
              setRef(next);
              setMessage(null);
              merge.reset();
            }}
            excludeBranches={[branch]}
            pinnedBranch={worktree.primaryRef}
          />
        </div>
        <SegmentedControl
          aria-label="How"
          className="w-full"
          optionClassName="flex-1 justify-center px-1 py-1 text-xs"
          value={method}
          onChange={(next) => {
            setPicked(next);
            merge.reset();
          }}
          options={METHODS}
        />
        <Outcome
          branch={branch}
          ref_={ref}
          method={method}
          preview={data}
          error={preview.error}
        />
        {method === "squash" && data !== undefined && data.incoming > 0 && (
          <Input
            aria-label="Commit message"
            placeholder="Commit message"
            value={squashMessage}
            onChange={(e) => setMessage(e.target.value)}
          />
        )}
        {blocked !== null && <Warning>{blocked}</Warning>}
        {blocked === null && merge.error && (
          <Warning>
            <InlineError
              multiline
              title="Couldn't merge"
              message={merge.error.message}
            />
          </Warning>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            {METHODS.find((m) => m.value === method)?.label}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

const DONE: Record<IntegrateMethod, (ref: string) => string> = {
  merge: (ref) => `Merged ${ref}`,
  squash: (ref) => `Squashed ${ref} into one commit`,
  rebase: (ref) => `Rebased onto ${ref}`,
  fastForward: (ref) => `Fast-forwarded to ${ref}`,
};

// What the move will do with the branch picked, in a line, and whether
// it will stop on conflicts.
function Outcome({
  branch,
  ref_: ref,
  method,
  preview,
  error,
}: {
  branch: string;
  ref_: string;
  method: IntegrateMethod;
  preview: MergePreview | undefined;
  error: Error | null;
}) {
  let line: string;
  if (ref === "") line = "Pick the branch to bring in.";
  else if (error) line = error.message;
  else if (!preview) line = `Comparing with ${ref}…`;
  else if (preview.incoming === 0) {
    line = `${branch} already has everything on ${ref}.`;
  } else {
    line = describe(branch, ref, method, preview);
  }
  const live = preview !== undefined && preview.incoming > 0;
  const conflicts = live && method !== "fastForward" ? preview.conflicts : null;
  // A rebase rewrites the branch's own commits, the pushed ones too.
  const pushed =
    live && method === "rebase" && preview.own > 0 ? preview.pushed : 0;
  return (
    <div className="space-y-1.5 text-sm">
      <p>{line}</p>
      {conflicts &&
        (conflicts.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Check aria-hidden className="size-3.5" />
            No conflicts
          </p>
        ) : (
          <Warning>
            {method === "rebase" ? "Likely conflicts" : "Conflicts"} in{" "}
            {nameConflicts(conflicts)}, to resolve before it finishes
          </Warning>
        ))}
      {pushed > 0 && (
        <Warning>
          {pushed === preview?.own
            ? "They're pushed already"
            : `${pushed} of them are pushed already`}
          , so pushing after takes a force push
        </Warning>
      )}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

function describe(
  branch: string,
  ref: string,
  method: IntegrateMethod,
  { incoming, own }: MergePreview,
): string {
  const commits = pluralize(incoming, "commit");
  const moves = `Moves ${branch} up to ${ref}, ${commits} on.`;
  switch (method) {
    case "merge":
      return `Brings in ${commits} with a merge commit.`;
    case "squash":
      return `Brings in ${commits} as one new commit.`;
    case "fastForward":
      return own === 0
        ? moves
        : `Can't fast-forward: ${branch} has ${pluralize(own, "commit")} ${ref} doesn't.`;
    case "rebase":
      return own === 0
        ? moves
        : `Replays ${branch}'s ${pluralize(own, "commit")} on top of ${ref}.`;
  }
}

function nameConflicts(paths: string[]): string {
  const named = paths.slice(0, NAMED_CONFLICTS);
  const rest = paths.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length === 1) return named[0] ?? "";
  return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}
