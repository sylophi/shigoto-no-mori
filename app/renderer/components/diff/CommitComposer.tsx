import { useRef, useState } from "react";
import {
  Combine,
  GitCommitHorizontal,
  Loader2,
  PencilLine,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { CommitDraft } from "@/lib/commitDraft";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import type { ChangedFile } from "@shared/schemas";

// Past this a summary is cut off in `git log --oneline`, on GitHub and
// in most other tools. Shown as a count, never enforced.
const SUMMARY_SOFT_LIMIT = 72;

// The message box at the foot of the changes list. Summary is the
// commit's first line. Description, when given, is its body. The draft
// itself belongs to the page (lib/commitDraft), which also empties it
// once the commit lands. Which branch it lands on is the branch bar's
// to say, right above.
//
// The button reads what the commit will take: the ticked files.
//
// Amending: the button turns into "Amend with ...", the file rules stay
// the same, and a message-only amend on a clean tree is allowed too.
//
// Before the button, while the last commit can be amended, a second one
// adds the ticked files to it in one click, its message left as it is.
export function CommitComposer({
  files,
  included,
  draft,
  onDraftChange,
  pending,
  error,
  amend,
  addToLast,
  onCommit,
}: {
  files: ChangedFile[];
  // How many of them are ticked.
  included: number;
  draft: CommitDraft;
  onDraftChange: (next: CommitDraft) => void;
  pending: boolean;
  error: Error | null;
  // The hash being rewritten, or null when this is a new commit.
  amend: { hash: string; onCancel: () => void } | null;
  // The last commit's subject, when the ticked files can go into it.
  addToLast: { subject: string; onAdd: () => void } | null;
  onCommit: () => void;
}) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // The description sits one line tall, as tall as what it holds, until
  // it is being written in: the sidebar's height goes to the files.
  const [writing, setWriting] = useState(false);
  const conflicted = files.filter((file) => file.conflicted).length;
  const summary = draft.summary.trim();
  const label = buttonLabel({
    pending,
    amending: amend !== null,
    total: files.length,
    included,
  });
  // Everything but the message is in place. When only the summary is
  // missing, the button's tooltip says so: conflicts have their own
  // line, and nothing ticked and a commit in flight say it on the button.
  const ready =
    !pending && conflicted === 0 && (included > 0 || amend !== null);
  const canCommit = ready && summary.length > 0;
  const blocked = ready && !canCommit ? "Write a summary first" : undefined;

  const submit = () => {
    if (canCommit) onCommit();
  };

  // The commit chord works from either field. Plain Enter in the summary
  // goes on to the description, the way a message is written in an
  // editor, rather than committing: Enter there is usually a reflex.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (e.target instanceof HTMLInputElement) {
      e.preventDefault();
      descriptionRef.current?.focus();
    }
  };

  // A whole message pasted into the summary (from a terminal, another
  // commit, an agent) would lose its line breaks to the single-line
  // field. Its first line becomes the summary and the rest the body.
  const onSummaryPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\n")) return;
    const input = e.currentTarget;
    const before = draft.summary.slice(0, input.selectionStart ?? 0);
    const after = draft.summary.slice(
      input.selectionEnd ?? draft.summary.length,
    );
    // Leading blank lines (a terminal copy often starts with one) would
    // otherwise make an empty summary.
    const [first = "", ...rest] = text
      .replace(/\r\n?/g, "\n")
      .replace(/^\s*\n/, "")
      .split("\n");
    const body = rest.join("\n").replace(/^\n+/, "").trimEnd();
    e.preventDefault();
    onDraftChange({
      summary: `${before}${first}${after}`,
      description: [body, draft.description.trim() && draft.description]
        .filter(Boolean)
        .join("\n\n"),
    });
  };

  // In characters, of what gets committed (the trimmed summary).
  const left = SUMMARY_SOFT_LIMIT - [...summary].length;
  const showCount = left < 10;
  const overLimit = left < 0;

  return (
    <div
      data-slot="commit-composer"
      className="flex flex-col gap-1.5 px-3 pt-1.5"
      // The description folds back once focus leaves the box, not when
      // it leaves the field: a click on Commit takes focus to the
      // button, and the box shrinking under the pointer mid-click would
      // move the button out from under it.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setWriting(false);
      }}
    >
      {amend && (
        <div className="flex items-center gap-1.5 rounded-md bg-amber-500/10 py-1 pr-1 pl-2 text-xs">
          <PencilLine
            aria-hidden
            className="size-3.5 shrink-0 text-amber-500"
          />
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
          >
            <X />
          </Button>
        </div>
      )}
      <div className="relative">
        <Input
          value={draft.summary}
          onChange={(e) => onDraftChange({ ...draft, summary: e.target.value })}
          onKeyDown={onKeyDown}
          onPaste={onSummaryPaste}
          placeholder="Summary (required)"
          aria-label="Commit summary"
          spellCheck
          disabled={pending}
          className={cn("w-full px-2.5 py-1.5 text-xs", showCount && "pr-9")}
        />
        {showCount && (
          <SimpleTooltip
            tip={
              overLimit
                ? `Past ${SUMMARY_SOFT_LIMIT} characters, most git tools cut the summary off`
                : `${left} left before most git tools cut the summary off`
            }
          >
            <span
              className={cn(
                "tabular absolute top-1/2 right-2.5 -translate-y-1/2 text-2xs",
                overLimit ? "text-amber-500" : "text-muted-foreground",
              )}
            >
              {left}
            </span>
          </SimpleTooltip>
        )}
      </div>
      <Textarea
        ref={descriptionRef}
        value={draft.description}
        onChange={(e) =>
          onDraftChange({ ...draft, description: e.target.value })
        }
        onKeyDown={onKeyDown}
        onFocus={() => setWriting(true)}
        placeholder="Description"
        aria-label="Commit description"
        rows={1}
        disabled={pending}
        className={cn(
          "[field-sizing:content] max-h-48 w-full resize-none px-2.5 py-1.5 text-xs transition-[min-height]",
          writing ? "min-h-20" : "min-h-0",
        )}
      />
      {conflicted > 0 && (
        <p className="text-xs text-amber-500">
          Resolve the {pluralize(conflicted, "conflicted file")} before
          committing.
        </p>
      )}
      {error && (
        <ErrorBanner>
          <pre className="max-h-32 overflow-auto font-mono text-2xs whitespace-pre-wrap select-text">
            {error.message}
          </pre>
        </ErrorBanner>
      )}
      <div className="flex gap-1.5">
        {addToLast && (
          <SimpleTooltip tip={`Add to “${addToLast.subject}”`}>
            <Button
              type="button"
              size="icon-sm"
              disabled={pending || conflicted > 0 || included === 0}
              onClick={addToLast.onAdd}
              aria-label="Add to the last commit"
            >
              <Combine aria-hidden />
            </Button>
          </SimpleTooltip>
        )}
        <SimpleTooltip tip={blocked}>
          <Button
            type="button"
            size="sm"
            disabled={!canCommit}
            onClick={submit}
            className="min-w-0 flex-1"
          >
            {pending ? (
              <Loader2 aria-hidden className="animate-spin" />
            ) : (
              <GitCommitHorizontal aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {canCommit && (
              <Kbd className="bg-primary-foreground/20 text-primary-foreground">
                ⌘↵
              </Kbd>
            )}
          </Button>
        </SimpleTooltip>
      </div>
    </div>
  );
}

// What the button says it will do: which of the files go.
function buttonLabel({
  pending,
  amending,
  total,
  included,
}: {
  pending: boolean;
  amending: boolean;
  total: number;
  included: number;
}): string {
  if (pending) return amending ? "Amending…" : "Committing…";
  const what = pluralize(included, "file");
  // "all 1 file" reads wrong, and with one file there is no "all".
  const scope = included === total && total > 1 ? `all ${what}` : what;
  if (amending) {
    return included === 0 ? "Amend the message" : `Amend with ${scope}`;
  }
  if (total === 0) return "Nothing to commit";
  if (included === 0) return "Nothing ticked";
  return `Commit ${scope}`;
}
