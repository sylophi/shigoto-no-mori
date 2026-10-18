// The hard reset dialog's content (HardResetDialog puts it in a
// ModalShell).
import type { ReactNode } from "react";
import { Button } from "../../../primitives/button.tsx";
import { InlineError } from "../../../primitives/inline-error.tsx";
import { SimpleTooltip } from "../../../primitives/tooltip.tsx";
import { Warning } from "../../../primitives/warning.tsx";
import { plural, pluralize } from "@shigomori/contracts/words";
import type { MergePreview } from "@shigomori/contracts/schemas";

// `git reset --hard` to any branch or commit, saying first what the
// branch loses and gains. What it throws away, commits and uncommitted
// files alike, comes back with the toast's Undo.
export function HardResetDialogView({
  branch,
  target,
  to,
  dirty,
  preview,
  previewError,
  resetError,
  blocked,
  pending,
  ready,
  onSubmit,
  onCancel,
}: {
  // The branch moved, and where to.
  branch: string;
  target: string;
  // The pick of where to (BranchCombobox).
  to: ReactNode;
  // Whether the worktree has uncommitted changes the reset throws away.
  dirty: boolean;
  // How far apart the two are, read once a target is picked.
  preview: MergePreview | undefined;
  previewError: Error | null;
  resetError: string | undefined;
  // Why nothing can reset right now.
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
          Hard reset <span className="font-mono">{branch}</span>
        </h2>
      </SimpleTooltip>
      <div className="space-y-1.5">
        <label htmlFor="reset-to" className="block text-xs font-medium">
          To
        </label>
        {to}
      </div>
      <Outcome
        branch={branch}
        ref_={target}
        dirty={dirty}
        preview={preview}
        error={previewError}
      />
      {resetError !== undefined ? (
        <Warning>
          <InlineError
            multiline
            title="Couldn't hard reset"
            message={resetError}
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
          onClick={onCancel}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" variant="destructive" size="sm" disabled={!ready}>
          Hard reset
        </Button>
      </div>
    </form>
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
  return `${unpushed} of them ${plural(unpushed, "isn't", "aren't")} on a remote`;
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
