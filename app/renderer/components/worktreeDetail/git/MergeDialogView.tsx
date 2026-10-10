// The merge dialog's content (MergeDialog puts it in a ModalShell).
import type { ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import { InlineError } from "@shigomori/ui/primitives/inline-error.tsx";
import { Input } from "@shigomori/ui/primitives/input.tsx";
import { SegmentedControl } from "@shigomori/ui/primitives/segmented-control.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { pluralize } from "@shigomori/ui/lib/pluralize.ts";
import type {
  IntegrateMethod,
  MergePreview,
} from "@shigomori/contracts/schemas";

// How many conflicted files the dialog names before it counts the rest.
const NAMED_CONFLICTS = 3;

const METHODS: { value: IntegrateMethod; label: string }[] = [
  { value: "merge", label: "Merge" },
  { value: "squash", label: "Squash" },
  { value: "rebase", label: "Rebase" },
  { value: "fastForward", label: "Fast-forward" },
];

// Another branch's work into this one, the four ways git has, each
// saying what it will do before it runs: how many commits come in, and
// which files would conflict. A merge, squash or rebase that conflicts
// stops for the Changes tab to settle, where the banner continues it.
// Otherwise the History tab opens on what it made.
export function MergeDialogView({
  branch,
  source,
  from,
  method,
  onMethod,
  preview,
  previewError,
  squashMessage,
  onSquashMessage,
  mergeError,
  blocked,
  pending,
  ready,
  onSubmit,
  onCancel,
}: {
  // The branch merged into, and the one brought in.
  branch: string;
  source: string;
  // The pick of the branch brought in (BranchCombobox).
  from: ReactNode;
  method: IntegrateMethod;
  onMethod: (method: IntegrateMethod) => void;
  // What the move would do, read once a branch is picked.
  preview: MergePreview | undefined;
  previewError: Error | null;
  squashMessage: string;
  onSquashMessage: (message: string) => void;
  mergeError: string | undefined;
  // Why nothing can merge right now.
  blocked: string | null;
  pending: boolean;
  ready: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
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
        {from}
      </div>
      <SegmentedControl
        aria-label="How"
        className="w-full"
        optionClassName="flex-1 justify-center px-1 py-1 text-xs"
        value={method}
        onChange={onMethod}
        options={METHODS}
      />
      <Outcome
        branch={branch}
        ref_={source}
        method={method}
        preview={preview}
        error={previewError}
      />
      {method === "squash" && preview !== undefined && preview.incoming > 0 && (
        <Input
          aria-label="Commit message"
          placeholder="Commit message"
          value={squashMessage}
          onChange={(e) => onSquashMessage(e.target.value)}
        />
      )}
      {/* The error first: a failure can leave the very state that
            blocks another go (a squash whose commit a hook refused). */}
      {mergeError !== undefined ? (
        <Warning>
          <InlineError multiline title="Couldn't merge" message={mergeError} />
        </Warning>
      ) : (
        blocked !== null && <Warning>{blocked}</Warning>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready}>
          {METHODS.find((m) => m.value === method)?.label}
        </Button>
      </div>
    </form>
  );
}

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
  if (ref === "") line = "Pick the branch to bring in.";
  else if (!preview) line = `Comparing with ${ref}…`;
  else if (preview.incoming === 0) {
    line = `${branch} already has everything on ${ref}.`;
  } else {
    line = describe(branch, ref, method, preview);
  }
  const live = preview !== undefined && preview.incoming > 0;
  const conflicts = live && method !== "fastForward" ? preview.conflicts : null;
  // A rebase rewrites the branch's own commits, the pushed ones too,
  // and replays a merge's commits in a line without it.
  const rebasing = live && method === "rebase" && preview.own > 0;
  const pushed = rebasing ? preview.pushed : 0;
  const merges = rebasing ? preview.ownMerges : 0;
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
      {merges > 0 && (
        <Warning>
          {merges === 1
            ? "The merge among them is flattened"
            : `The ${merges} merges among them are flattened`}{" "}
          into one line
        </Warning>
      )}
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

function nameConflicts(paths: readonly string[]): string {
  const named = paths.slice(0, NAMED_CONFLICTS);
  const rest = paths.length - named.length;
  if (rest > 0) return `${named.join(", ")} and ${rest} more`;
  if (named.length === 1) return named[0] ?? "";
  return `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}
