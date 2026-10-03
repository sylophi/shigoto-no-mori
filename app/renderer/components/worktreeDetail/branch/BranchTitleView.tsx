// The worktree page's branch title at rest, as BranchTitle draws it
// when nobody is renaming: the branch, the hover-revealed pencil, the
// branch switcher's trigger and the copy button. BranchTitle passes its
// live switcher in. Without one the trigger is drawn as it sits closed.
import type { ReactNode, Ref } from "react";
import { ChevronsUpDown, Pencil } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { CopyButton } from "@/components/ui/copy-button";

export function BranchTitleView({
  branch,
  detached,
  onRename,
  switcher,
  titleRef,
}: {
  branch: string;
  detached: boolean;
  onRename?: () => void;
  switcher?: ReactNode;
  // The title, which the switcher's popup anchors to.
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="group/copy flex min-w-0 items-center gap-1.5">
      <h1
        ref={titleRef}
        className="min-w-0 truncate font-mono text-2xl font-medium tracking-tight"
        title={detached ? "Detached HEAD (commit hash)" : undefined}
      >
        <BranchLabel
          branch={branch}
          detached={detached}
          suffixClassName="text-base tracking-normal"
        />
      </h1>
      {!detached && (
        <button
          type="button"
          onClick={onRename}
          aria-label="Rename branch"
          title="Rename branch"
          data-icon-button
          className="rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 phone:opacity-100"
        >
          <Pencil className="size-3.5" />
        </button>
      )}
      {switcher ?? <BranchSwitcherTrigger />}
      <CopyButton
        value={branch}
        label={detached ? "Copy commit hash" : "Copy branch name"}
      />
    </div>
  );
}

// The switcher's trigger as it sits closed, for a title drawn without
// the live switcher (BranchSwitcher.tsx draws the same classes).
export const BRANCH_SWITCHER_TRIGGER_CLASS =
  "rounded-md p-1 text-muted-foreground/50 opacity-0 transition-opacity group-hover/copy:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[popup-open]:bg-accent data-[popup-open]:text-foreground data-[popup-open]:opacity-100 phone:opacity-100";

function BranchSwitcherTrigger() {
  return (
    <button
      type="button"
      aria-label="Switch branch"
      title="Switch branch"
      data-icon-button
      className={BRANCH_SWITCHER_TRIGGER_CLASS}
    >
      <ChevronsUpDown aria-hidden className="size-3.5" />
    </button>
  );
}
