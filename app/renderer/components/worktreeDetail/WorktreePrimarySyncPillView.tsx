import { ArrowDown } from "lucide-react";
import { pluralize } from "@/lib/pluralize";
import { SyncActionButton } from "./SyncActionButton";

const noop = () => undefined;

// The branch's pill for catching up with the primary branch, as
// WorktreePrimarySyncPill draws it: "Sync 3 commits from origin/main".
export function WorktreePrimarySyncPillView({
  behindPrimary,
  primaryRef,
  pending = false,
  onClick = noop,
}: {
  behindPrimary: number;
  primaryRef: string | undefined;
  pending?: boolean;
  onClick?: () => void;
}) {
  const branchName = primaryRef ?? "primary";
  return (
    <SyncActionButton
      tone="sky"
      icon={ArrowDown}
      label={`Sync ${pluralize(behindPrimary, "commit")} from ${branchName}`}
      title={`git fetch && git rebase ${branchName}, falling back to a merge on conflict`}
      pending={pending}
      onClick={onClick}
    />
  );
}
