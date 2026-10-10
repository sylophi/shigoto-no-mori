// Why a peer's worktree offers no mirror or transplant: its repo has no
// identity the two devices could match a copy by.
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";

const NO_IDENTITY_NOTE =
  "No shared identity for this repo (no common remote, and no main, master, dev or remote HEAD branch), so it can't be mirrored or transplanted.";

export function NoIdentityNoteView() {
  return (
    <SimpleTooltip whenTruncated tip={NO_IDENTITY_NOTE}>
      <span className="min-w-0 truncate text-xs text-muted-foreground">
        {NO_IDENTITY_NOTE}
      </span>
    </SimpleTooltip>
  );
}
