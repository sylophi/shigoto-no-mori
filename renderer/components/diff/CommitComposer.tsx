import { GitCommitHorizontal, Loader2, PencilLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import type { CommitDraft } from "@/lib/commitDraft";
import { pluralize } from "@/lib/pluralize";
import type { ChangedFile, Worktree } from "@shared/schemas";
import { includedFiles } from "./changesControls";

// The message box at the foot of the changes rail. Summary is the
// commit's first line. Description, when given, is its body. The draft
// itself belongs to the page (lib/commitDraft), which also empties it
// once the commit lands.
//
// The button reads what the commit will take. With files ticked it
// commits those. With nothing ticked it commits everything listed,
// the way a fresh commit usually goes, and the reason a tree touched
// only from a terminal (where nothing is staged yet) isn't a dead end.
//
// Amending: the button turns into "Amend with ...", the file rules stay
// the same, and a message-only amend on a clean tree is allowed too.
export function CommitComposer({
  worktree,
  files,
  draft,
  onDraftChange,
  pending,
  error,
  amend,
  onCommit,
}: {
  worktree: Worktree;
  files: ChangedFile[];
  draft: CommitDraft;
  onDraftChange: (next: CommitDraft) => void;
  pending: boolean;
  error: Error | null;
  // The hash being rewritten, or null when this is a new commit.
  amend: { hash: string; onCancel: () => void } | null;
  onCommit: () => void;
}) {
  const included = includedFiles(files).length;
  const conflicted = files.some((file) => file.conflicted);
  const copy = buttonCopy({
    pending,
    amending: amend !== null,
    total: files.length,
    included,
  });
  const canCommit =
    draft.summary.trim().length > 0 &&
    (files.length > 0 || amend !== null) &&
    !conflicted &&
    !pending;

  const submit = () => {
    if (canCommit) onCommit();
  };

  // The commit chord works from either field. Plain Enter in the summary
  // stays a no-op rather than committing: the field looks like a search
  // box, and Enter there is usually a reflex.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-slot="commit-composer"
      className="flex flex-col gap-2 border-t border-border p-3"
    >
      {amend && (
        <div className="flex items-center gap-1.5 text-xs">
          <PencilLine aria-hidden className="size-3.5 text-amber-500" />
          <span className="min-w-0 flex-1 truncate">
            Amending{" "}
            <span className="font-mono text-muted-foreground">
              {amend.hash}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={amend.onCancel}
            disabled={pending}
            aria-label="Stop amending"
            title="Stop amending"
          >
            <X />
          </Button>
        </div>
      )}
      <Input
        value={draft.summary}
        onChange={(e) => onDraftChange({ ...draft, summary: e.target.value })}
        onKeyDown={onKeyDown}
        placeholder="Summary (required)"
        aria-label="Commit summary"
        spellCheck
        disabled={pending}
        className="w-full px-2.5 py-1.5 text-xs"
      />
      <Textarea
        value={draft.description}
        onChange={(e) =>
          onDraftChange({ ...draft, description: e.target.value })
        }
        onKeyDown={onKeyDown}
        placeholder="Description"
        aria-label="Commit description"
        rows={3}
        disabled={pending}
        className="w-full resize-none px-2.5 py-1.5 text-xs"
      />
      {conflicted && (
        <p className="text-xs text-amber-500">
          Resolve the conflicted files before committing.
        </p>
      )}
      {error && (
        <ErrorBanner>
          <pre className="max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
            {error.message}
          </pre>
        </ErrorBanner>
      )}
      <Button
        type="button"
        size="sm"
        disabled={!canCommit}
        onClick={submit}
        title={copy.title}
        className="w-full justify-start"
      >
        {pending ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : (
          <GitCommitHorizontal aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate text-left">
          {copy.label}
          {!worktree.detached && !amend && (
            <>
              {" "}
              to <span className="font-mono">{worktree.branch}</span>
            </>
          )}
        </span>
        {!pending && (
          <Kbd className="bg-primary-foreground/20 text-primary-foreground">
            ⌘↵
          </Kbd>
        )}
      </Button>
    </div>
  );
}

// What the button says it will do, and the longer version on hover.
// Ticked files go. With nothing ticked, everything listed goes.
function buttonCopy({
  pending,
  amending,
  total,
  included,
}: {
  pending: boolean;
  amending: boolean;
  total: number;
  included: number;
}): { label: string; title: string } {
  if (pending) {
    return { label: amending ? "Amending…" : "Committing…", title: "" };
  }
  const what = pluralize(included > 0 ? included : total, "file");
  const title =
    total === 0
      ? "Only the message changes"
      : included > 0
        ? `Commit the ${what} ticked`
        : "Nothing is ticked, so every listed file is committed";
  if (amending) {
    const label =
      total === 0
        ? "Amend the message"
        : included > 0
          ? `Amend with ${what}`
          : `Amend with all ${what}`;
    return { label, title };
  }
  if (total === 0) return { label: "Nothing to commit", title: "" };
  return {
    label: included > 0 ? `Commit ${what}` : `Commit all ${what}`,
    title,
  };
}
