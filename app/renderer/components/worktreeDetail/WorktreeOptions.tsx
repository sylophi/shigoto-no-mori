// The worktree's own options, one switch each, in a popover off the
// footer: the footer keeps one button for all of them however many
// there are. Below them, the page's rarer verbs (OptionAction), which
// close it to open a dialog.
import { Archive, RefreshCw, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { ToggleRowView } from "@/components/shared/ToggleRowView";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useSetAutoPull,
  useSetShelved,
} from "@/hooks/worktrees/useWorktreeMutations";
import { isManagedWorktree, type Worktree } from "@shigomori/contracts/schemas";
import { FooterVerb, LABEL_RANK } from "./footerFit";

export function WorktreeOptions({
  worktree,
  busy,
  children,
}: {
  worktree: Worktree;
  // A delete in flight: nothing here changes under it.
  busy: boolean;
  // OptionAction rows.
  children?: ReactNode;
}) {
  const setAutoPull = useSetAutoPull();
  const setShelved = useSetShelved();
  const target = { projectId: worktree.projectId, worktreeId: worktree.id };
  // Once on, auto-pull stays switchable even if the upstream vanishes,
  // so it can be turned off again.
  const canAutoPull =
    worktree.autoPull || (worktree.hasUpstream && !worktree.detached);
  // The primary checkout is the project itself, never on a shelf.
  const canShelve = isManagedWorktree(worktree);
  // Set when a row hands off to a dialog: focus then stays out of the
  // footer rather than return to Options behind the dialog, where a
  // keypress would reopen the popover over it.
  const handedOff = useRef(false);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) handedOff.current = false;
      }}
    >
      <FooterVerb
        rank={LABEL_RANK.options}
        icon={<SlidersHorizontal />}
        label="Options"
        variant="ghost"
        className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:bg-accent data-popup-open:text-foreground"
        render={<PopoverTrigger />}
      />
      <PopoverContent
        side="top"
        align="end"
        className="w-80"
        finalFocus={() => !handedOff.current}
      >
        <div className="flex flex-col gap-3 p-2">
          <ToggleRowView
            label={<OptionLabel icon={<RefreshCw />} name="Auto-pull" />}
            description={
              canAutoPull
                ? "Fast-forward from the upstream after each fetch, while there are no local commits, changes or running scripts."
                : "Needs a branch that tracks an upstream."
            }
            checked={worktree.autoPull}
            disabled={!canAutoPull || busy || setAutoPull.isPending}
            onCheckedChange={(autoPull) =>
              setAutoPull.mutate({ ...target, autoPull })
            }
          />
          {canShelve && (
            <ToggleRowView
              label={<OptionLabel icon={<Archive />} name="Shelved" />}
              description="Folded away under Shelved in the sidebar, out of the main list."
              checked={worktree.shelved}
              disabled={busy || setShelved.isPending}
              onCheckedChange={(shelved) =>
                setShelved.mutate({ ...target, shelved })
              }
            />
          )}
          <div
            className="contents"
            onClickCapture={() => (handedOff.current = true)}
          >
            {children}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// An option's icon and name, as a row in the popover wears them.
function OptionLabel({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
      {icon}
      {name}
    </span>
  );
}

// A verb in the Options popover: its icon and name, as an option's
// row has them (OptionLabel), and what it does beneath. It closes the
// popover, so the dialog it opens stands alone.
export function OptionAction({
  icon,
  label,
  description,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <PopoverClose
      onClick={onClick}
      className="-m-1 flex flex-col items-start rounded-md p-1 text-left hover:bg-muted dark:hover:bg-muted/50"
    >
      <span className="text-sm">
        <OptionLabel icon={icon} name={label} />
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </PopoverClose>
  );
}
